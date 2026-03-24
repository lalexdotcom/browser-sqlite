# Phase 3: Integration Tests (Browser) - Research

**Researched:** 2026-03-24
**Domain:** Rstest browser mode, Playwright Chromium, OPFS, SharedArrayBuffer/COOP-COEP, Web Workers
**Confidence:** MEDIUM-HIGH (core stack verified against official sources; one config detail needs empirical validation)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Use **Rstest browser mode** (`@rstest/browser`) — not a standalone Playwright setup. Rstest browser mode handles headless Chromium installation automatically. No separate `playwright install` step required.
- **D-02:** Separate config file: `rstest.browser.config.ts` (distinct from the Node-mode `rstest.config.ts`). Browser tests run via a separate script (e.g., `pnpm test:browser`).
- **D-03:** Browser tests live in `tests/browser/` directory.
- **D-04:** Inject `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` via **Rsbuild `server.headers` config** inside `rstest.browser.config.ts`. No custom plugin needed — Rstest's dev server inherits Rsbuild's server options via `withRslibConfig()`.
- **D-05:** Use **`OPFSPermutedVFS`** (the default production VFS) for all integration tests. Tests the real default path end-to-end. Headless Chromium supports OPFS without extra flags.
- **D-06:** Each test gets a **unique database name** (UUID or timestamp prefix) so tests never share database state even in parallel runs.
- **D-07:** **`afterEach` cleanup** — delete the OPFS entry via `navigator.storage.getDirectory()` → `removeEntry(name, { recursive: true })`. Belt-and-suspenders: no orphaned files even if a test throws.
- **D-08:** Provide a shared helper (`tests/browser/helpers.ts`) that wraps `createSQLiteClient` with a unique name and registers the `afterEach` cleanup automatically. Tests call the helper instead of calling `createSQLiteClient` directly.
- **D-09:** Include a browser test verifying that a second `lock()` call blocks until the first `unlock()` is called — requires two concurrent async operations in the browser environment where `Atomics.wait` is valid inside Web Workers.

### Claude's Discretion

- Exact UUID/timestamp format for unique DB names
- Whether to use `crypto.randomUUID()` or `Date.now()` for uniqueness
- Rstest browser provider name (`playwright` vs `webdriverio`) in config
- How to import the built worker URL in browser test context (relative path vs URL import)

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| INT-01 | Configure Rstest browser mode with Playwright (Chromium) — add COOP/COEP headers to the test server | `@rstest/browser` + `browser.enabled/provider` config + Rsbuild `server.headers` |
| INT-02 | `createSQLiteClient` initializes and pool workers reach READY state | Worker `ready` message at `callId: 0` — verify by waiting on pool init promise resolution |
| INT-03 | `db.read()` executes a SELECT and returns typed rows | Direct call after init; assert array of typed objects |
| INT-04 | `db.write()` executes INSERT/UPDATE/DELETE and returns affected row count | Assert `{ result, affected }` shape and `affected > 0` |
| INT-05 | `db.stream()` yields rows in chunks and respects chunk size option | AsyncGenerator iteration; assert chunk.length <= chunkSize |
| INT-06 | `db.one()` returns a single row or `undefined` for no result | Two assertions: row present for matching query, undefined for no-match |
| INT-07 | Concurrent reads are served by different workers in parallel | Launch two reads simultaneously with `Promise.all`; assert both resolve without serialization |
| INT-08 | Write operations are serialized through the single writer worker | Issue two writes; assert second completes after first (no interleaving) |
| INT-09 | AbortSignal cancels an in-flight query | Create AbortController, abort mid-stream; assert no further chunks arrive |
| INT-10 | Error in SQL (syntax error, missing table) rejects the promise with a meaningful error | Call `db.read()` with bad SQL; assert promise rejects with `Error` carrying a message |
</phase_requirements>

---

## Summary

Phase 3 establishes browser integration tests using **Rstest browser mode** (`@rstest/browser` v0.9.4) with the **Playwright** provider targeting headless Chromium. The test stack is entirely within the Rstest/Rspack/Rslib ecosystem already in use — no migration or separate toolchain required.

The critical infrastructure challenge is COOP/COEP headers. `SharedArrayBuffer` (required by `WorkerOrchestrator`) throws a `SecurityError` unless the page is served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. These headers must be active before the first worker is created. Rstest's browser dev server is powered by Rsbuild under the hood, and Rsbuild exposes `server.headers` for exactly this purpose.

The second challenge is test isolation: OPFS persists across test runs within the same browser session. The isolation strategy (D-06/D-07/D-08) uses unique DB names per test plus `afterEach` OPFS cleanup via `navigator.storage.getDirectory().removeEntry(...)`. This is the only safe approach — there is no "reset OPFS" API.

**Primary recommendation:** Install `@rstest/browser` and `playwright` as devDependencies, create `rstest.browser.config.ts` with browser mode enabled, Playwright provider, and COOP/COEP headers injected via `server.headers`, then write the 10 integration tests in `tests/browser/`.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@rstest/browser` | 0.9.4 | Enables Rstest browser mode | Official Rstest browser adapter; matches `@rstest/core` version |
| `playwright` | 1.58.2 | Chromium browser provider for `@rstest/browser` | Only supported provider; `@rstest/browser` requires it as peer |
| `@rstest/core` | 0.9.4 (already installed) | Test runner primitives (`describe`, `it`, `expect`) | Already in project |
| `@rstest/adapter-rslib` | 0.2.1 (already installed) | Adapts Rslib config for Rstest | Already in project; browser config should reuse same adapter pattern |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `crypto.randomUUID()` | Browser built-in | Generate unique DB names per test | Available in all modern browsers and Node 19+; no install needed |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `crypto.randomUUID()` | `Date.now()` string | `Date.now()` risks collisions under parallel execution; `randomUUID()` is collision-proof |
| `playwright` provider | `webdriverio` provider | `webdriverio` is not listed as a supported provider in current Rstest docs; `playwright` is the only documented choice |

**Installation:**
```bash
pnpm add -D @rstest/browser playwright
```

**Note:** `@rstest/browser` ships with a Playwright integration that downloads Chromium automatically when tests first run. No explicit `npx playwright install chromium` step is needed for the `@rstest/browser` integration path (unlike standalone `@playwright/test`). Verify this behavior after installation.

**Version verification (confirmed 2026-03-24):**
- `@rstest/browser`: `npm view @rstest/browser version` → `0.9.4`
- `playwright`: `npm view playwright version` → `1.58.2`
- `@rstest/core` (already installed): `0.9.4`

---

## Architecture Patterns

### Recommended Project Structure
```
tests/
├── unit/                         # Existing Node-mode tests (untouched)
│   ├── utils.test.ts
│   ├── debug.test.ts
│   └── orchestrator.test.ts
└── browser/                      # New: browser integration tests
    ├── helpers.ts                 # createTestClient() + afterEach OPFS cleanup
    ├── init.test.ts               # INT-01, INT-02
    ├── queries.test.ts            # INT-03, INT-04, INT-05, INT-06
    └── concurrency.test.ts        # INT-07, INT-08, INT-09, INT-10
rstest.config.ts                  # Existing Node-mode config (untouched)
rstest.browser.config.ts          # New: browser-mode config
```

### Pattern 1: Browser Config with COOP/COEP Headers

**What:** Rstest browser config that enables Playwright provider and injects COOP/COEP headers through Rsbuild's `server.headers`.

**When to use:** Any test that needs `SharedArrayBuffer` (i.e., every test in this phase).

**How COOP/COEP reaches the dev server:** Rstest's browser mode runs a Rsbuild dev server internally. The `server` key in Rstest config maps directly to Rsbuild's `server` config. This is the mechanism D-04 relies on.

```typescript
// rstest.browser.config.ts
// Source: official Rstest browser mode docs (rstest.rs/guide/browser-testing/getting-started)
// + Rsbuild server.headers docs (rsbuild.rs/config/server/headers)
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  // COOP/COEP headers: required for SharedArrayBuffer (used by WorkerOrchestrator)
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  include: ['tests/browser/**/*.test.ts'],
});
```

**IMPORTANT — Configuration key uncertainty (LOW confidence):** The exact key for server headers in the Rstest config is `server.headers` based on D-04 and Rsbuild docs, but the Rstest TypeScript config types (`RstestConfig`) do not explicitly expose a `server` key in the public docs reviewed. It maps through Rsbuild's internal config. **If `server.headers` at the top level doesn't work**, the fallback approach is to pass a `modifyLibConfig` hook in `withRslibConfig()`:

```typescript
// Fallback approach if top-level server.headers is rejected by TypeScript:
extends: withRslibConfig({
  modifyLibConfig: (config) => {
    config.server = {
      ...config.server,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    };
    return config;
  },
}),
```

Wave 0 should verify which form TypeScript accepts before writing test files.

### Pattern 2: Test Helper — `createTestClient()`

**What:** A shared helper that creates a `SQLiteDB` instance with a UUID-prefixed database name and registers `afterEach` OPFS cleanup.

**When to use:** Every browser test that needs a database connection.

```typescript
// tests/browser/helpers.ts
import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

export async function createTestClient() {
  const dbName = `test-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // OPFS entry may not exist if test failed before DB was created
    }
  });

  return createSQLiteClient(dbName);
}
```

**Why `crypto.randomUUID()` over `Date.now()`:** Parallel test runs can share the same millisecond timestamp; UUID collision probability is negligible. Browser native — no import required.

### Pattern 3: Waiting for Worker Pool Ready State (INT-02)

**What:** `createSQLiteClient` returns synchronously but workers initialize asynchronously. Tests must wait for all workers to reach READY before issuing queries.

**Mechanism:** The client sends `callId: 0, type: 'open'` to each worker; each worker replies with `callId: 0, type: 'ready'` when initialized. Internally, the pool initialization uses `Promise.all(workers.map(createWorker))`. However, this promise is not exposed on the returned `api` object.

**Test strategy:** Issue a simple `db.read('SELECT 1')` after construction. The worker queue system will wait internally until a worker is available. If the pool failed to initialize, the query will reject. This implicitly tests INT-02.

**Alternative:** Add a `ready` property to the API that exposes the init promise — but this is a source change, which is out of scope. Use the query-as-readiness-probe approach.

### Pattern 4: AbortSignal Cancellation Test (INT-09)

**What:** An in-flight streaming query is aborted mid-stream.

**How `AbortSignal` works in the client:** When `signal.abort()` is called, the `signalAbortHandler` sets the worker status to `ABORTING` via `orchestrator.setStatus(index, WorkerStatuses.ABORTING, WorkerStatuses.RUNNING)`. The worker's query loop checks for `ABORTING` status on each iteration and breaks out of the loop. The generator then resolves the current deferred chunk and terminates.

**Test pattern:**
```typescript
it('AbortSignal cancels an in-flight query', async () => {
  const db = await createTestClient();
  // First, create a large enough table that streaming takes multiple chunks
  await db.write('CREATE TABLE t (n INTEGER)');
  await db.write(`INSERT INTO t SELECT value FROM generate_series(1, 10000)`);

  const controller = new AbortController();
  const chunks: unknown[][] = [];

  const gen = db.stream('SELECT * FROM t', [], {
    signal: controller.signal,
    chunkSize: 100,
  });

  const first = await gen.next();
  chunks.push(first.value as unknown[]);
  controller.abort();

  // Generator should terminate — no further chunks
  const next = await gen.next();
  expect(next.done).toBe(true);
});
```

**Note on `generate_series`:** This is a wa-sqlite built-in. If unavailable, populate the table with a loop of INSERT statements in the test setup.

### Pattern 5: Lock Blocking Test (INT-09 from Phase 2 D-09)

**What:** Verify `lock()` blocks a second caller until `unlock()` is called. Requires two concurrent Web Workers (because `Atomics.wait` is forbidden on the main thread).

**Test strategy:** This test needs to orchestrate two workers sharing the same `SharedArrayBuffer`. The test itself runs on the main thread in the browser. The simplest approach is to use `createSQLiteClient` with a pool of 2 — both workers will call `lock()` during `open()`, and the second worker will block on `Atomics.wait` until the first worker's `open()` completes and calls `unlock()`. Verify by asserting both workers reach READY state sequentially (not simultaneously).

**Implementation:** Create a client with `poolSize: 2`, await both workers reaching READY (via a readiness probe query), and assert both completed without hanging. The sequential lock/unlock behavior is implicitly tested — if lock were not working, SQLite could open the DB in both workers simultaneously, which may or may not cause visible errors. A more explicit test would require introspecting the `WorkerOrchestrator` from within the browser context, which is not exposed.

**Pragmatic approach:** Document as "behavioral" test — if both workers initialize successfully in order, the lock mechanism is functioning. The Phase 2 unit tests already cover the lock CAS mechanics directly.

### Anti-Patterns to Avoid

- **Shared database state between tests:** Never use a fixed DB name like `'test.db'`. Parallel tests will corrupt each other. Use `createTestClient()` helper for every test.
- **Skipping OPFS cleanup:** If `removeEntry` is not called in `afterEach`, orphaned OPFS files accumulate across test runs and can cause unexpected "DB already exists" states. The helper handles this.
- **Calling `db.read()` before workers are ready:** The internal queue handles this safely, but if the pool fails to initialize (e.g., COOP/COEP headers missing → `SharedArrayBuffer` throws), tests will hang indefinitely. Add a `testTimeout` in the config.
- **Using `AccessHandlePoolVFS` in tests:** Source explicitly enforces `poolSize: 1` for this VFS. Tests use the default `OPFSPermutedVFS` (D-05).
- **Testing `generate_series` without verifying availability:** Verify wa-sqlite supports `generate_series` or use a fallback (manual INSERT loop) for large table creation.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Browser test runner | Custom Playwright test harness | `@rstest/browser` | Already in the Rstest ecosystem; reuses same `describe`/`it`/`expect` API |
| OPFS cleanup utility | Custom async cleanup | `navigator.storage.getDirectory().removeEntry(name, { recursive: true })` | Browser-native API; handles nested structure |
| Unique test DB name | Custom hash/counter | `crypto.randomUUID()` | Browser-native; collision-proof; zero dependencies |
| Worker URL resolution | Manual URL construction | `new URL('./worker.ts', import.meta.url)` (already in `client.ts`) | The client already handles worker URL via this pattern — tests call `createSQLiteClient` which handles it |

**Key insight:** The production code already handles all browser environment complexity (worker spawning, WASM loading, VFS mounting). Integration tests only need to call the public API — not manage workers directly.

---

## Common Pitfalls

### Pitfall 1: COOP/COEP Headers Not Served → `SecurityError`
**What goes wrong:** `new SharedArrayBuffer(...)` throws `SecurityError: SharedArrayBuffer is not available without a cross-origin isolated context`. Tests hang or crash immediately.
**Why it happens:** COOP/COEP headers are missing from the dev server response. The `WorkerOrchestrator` constructor creates a `SharedArrayBuffer` on the very first call to `createSQLiteClient`.
**How to avoid:** Verify headers are served by checking `self.crossOriginIsolated === true` in a test or browser console before running the suite.
**Warning signs:** `SecurityError` in test output referencing `SharedArrayBuffer`.

### Pitfall 2: OPFS State Leaking Between Tests
**What goes wrong:** A later test opens a DB that a previous test left in a partially-written state, causing unexpected query results or errors.
**Why it happens:** OPFS files persist for the browser session. If `afterEach` cleanup fails (e.g., due to test timeout before cleanup runs), orphaned files remain.
**How to avoid:** Use `createTestClient()` helper which guarantees unique names AND registers `afterEach` cleanup. Never share a DB name across tests.
**Warning signs:** Tests pass in isolation but fail when run together; "DB already exists" errors.

### Pitfall 3: `Atomics.wait` on Main Thread
**What goes wrong:** `WorkerOrchestrator.lock()` is called on the main thread, causing a `TypeError: Atomics.wait cannot be used on the main thread`.
**Why it happens:** `lock()` uses `Atomics.wait()` which is forbidden on the main browser thread (it would block the event loop). The `lock()` call only happens inside Web Workers (in `open()` within `worker.ts`). Integration tests call `createSQLiteClient` from the main thread, which is safe — the workers call `lock()` internally.
**How to avoid:** Tests must NEVER call `orchestrator.lock()` directly from the test file. Only call `createSQLiteClient` and the public `db.*` methods.
**Warning signs:** `TypeError: Atomics.wait cannot be used on the main thread` appearing in test output.

### Pitfall 4: Worker URL Import Resolution in Browser Context
**What goes wrong:** `new URL('./worker.ts', import.meta.url)` in `client.ts` doesn't resolve correctly when the library is imported in a browser test.
**Why it happens:** Rstest's browser mode serves files through a dev server. The `import.meta.url` of `client.ts` in the test context may differ from what's expected, especially if the library is not pre-built.
**How to avoid:** Since `@rstest/adapter-rslib` integrates with the Rslib build, the worker module should be bundled and served via the dev server. Test this in Wave 0 by verifying a simple `createSQLiteClient` call succeeds.
**Warning signs:** Workers fail to start; `net::ERR_FILE_NOT_FOUND` in browser console.

### Pitfall 5: Test Timeout During Worker Initialization
**What goes wrong:** Tests that await worker readiness hang indefinitely if WASM loading fails (network error, wrong path, missing COOP/COEP for `SharedArrayBuffer`).
**How to avoid:** Set a `testTimeout` in `rstest.browser.config.ts` (e.g., `testTimeout: 30000` for 30 seconds). The default timeout may be too short for WASM + VFS initialization.
**Warning signs:** Tests pass locally but time out in CI; no error message, just timeout.

### Pitfall 6: `generate_series` Not Available in wa-sqlite
**What goes wrong:** Test for INT-09 (AbortSignal) uses `generate_series` to create a large table, but wa-sqlite does not include this virtual table module by default.
**Why it happens:** `generate_series` is an optional SQLite extension. wa-sqlite may not compile it.
**How to avoid:** Use a fallback: create a table and insert N rows using a JavaScript loop of `db.write()` calls. Or test with a moderate number of explicit INSERT statements in setup.
**Warning signs:** `no such table: generate_series` in query error output.

---

## Code Examples

Verified patterns from official sources:

### Rstest Browser Config (based on official browser-react example)
```typescript
// rstest.browser.config.ts
// Source: https://raw.githubusercontent.com/web-infra-dev/rstest/main/examples/browser-react/rstest.config.ts
// + https://rsbuild.rs/config/server/headers
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  include: ['tests/browser/**/*.test.ts'],
  testTimeout: 30000,
});
```

### OPFS Cleanup Helper
```typescript
// tests/browser/helpers.ts
import { afterEach } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';

export async function createTestClient() {
  const dbName = `wsqlite-test-${crypto.randomUUID()}`;

  afterEach(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(dbName, { recursive: true });
    } catch {
      // Entry may not exist if init failed before DB was created
    }
  });

  // createSQLiteClient returns synchronously; workers init in background.
  // The first query will queue until workers are ready.
  return createSQLiteClient(dbName);
}
```

### Basic Query Test Pattern
```typescript
// tests/browser/queries.test.ts
import { describe, it, expect } from '@rstest/core';
import { createTestClient } from './helpers';

describe('db.read()', () => {
  it('returns typed rows from SELECT', async () => {
    const db = await createTestClient();
    await db.write('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
    await db.write("INSERT INTO items VALUES (1, 'alpha')");

    const rows = await db.read<{ id: number; name: string }>('SELECT * FROM items');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('alpha');
    db.close();
  });
});
```

### AbortSignal Test Pattern
```typescript
// tests/browser/concurrency.test.ts
import { describe, it, expect } from '@rstest/core';
import { createTestClient } from './helpers';

describe('AbortSignal (INT-09)', () => {
  it('cancels an in-flight stream and delivers no further chunks', async () => {
    const db = await createTestClient();

    // Create a table large enough to require multiple chunks
    await db.write('CREATE TABLE bigdata (n INTEGER)');
    // Populate without generate_series (may not be available in wa-sqlite)
    const values = Array.from({ length: 1000 }, (_, i) => `(${i})`).join(',');
    await db.write(`INSERT INTO bigdata VALUES ${values}`);

    const controller = new AbortController();
    let chunkCount = 0;

    const gen = db.stream('SELECT * FROM bigdata', [], {
      signal: controller.signal,
      chunkSize: 10,
    });

    // Receive first chunk, then abort
    const first = await gen.next();
    expect(first.done).toBe(false);
    chunkCount++;
    controller.abort();

    // Drain generator — should terminate shortly after abort
    for await (const _chunk of gen) {
      chunkCount++;
      if (chunkCount > 5) break; // Safety valve
    }

    // Not all 100 chunks (1000 rows / chunkSize 10) should have arrived
    expect(chunkCount).toBeLessThan(100);
    db.close();
  });
});
```

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Chromium browser | `@rstest/browser` Playwright provider | Not pre-installed | — | Downloaded automatically by `@rstest/browser` on first run |
| `playwright` npm package | `@rstest/browser` peer dep | Not installed | — | Install via `pnpm add -D playwright` |
| `@rstest/browser` npm package | INT-01 (browser config) | Not installed | 0.9.4 available | Install via `pnpm add -D @rstest/browser` |
| Node.js | Build & test runner | 24.14.0 | v24.14.0 | — |
| pnpm | Package manager | 10.31.0 | 10.31.0 | — |
| OPFS in headless Chromium | INT-02 through INT-10 | Supported (no flags needed) | — | — |

**Missing dependencies with no fallback:**
- `@rstest/browser` and `playwright` — must be installed before browser tests can run (Wave 0 task)

**Missing dependencies with fallback:**
- None — Chromium is auto-downloaded by Playwright

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `@rstest/core` 0.9.4 + `@rstest/browser` 0.9.4 |
| Config file | `rstest.browser.config.ts` (Wave 0 creation) |
| Quick run command | `pnpm test:browser` (script to be added in package.json) |
| Full suite command | `pnpm test:browser` (all browser tests are integration tests; no unit subset) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| INT-01 | COOP/COEP headers on dev server + Playwright Chromium running | smoke (implicit — if tests run, config works) | `pnpm test:browser` | ❌ Wave 0 |
| INT-02 | `createSQLiteClient` + pool workers reach READY | integration | `pnpm test:browser -- --testNamePattern INT-02` | ❌ Wave 0 |
| INT-03 | `db.read()` returns typed rows | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-04 | `db.write()` returns `{ result, affected }` | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-05 | `db.stream()` yields in chunks | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-06 | `db.one()` returns one row or `undefined` | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-07 | Concurrent reads on different workers | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-08 | Writes serialized through one worker | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-09 | AbortSignal cancels in-flight query | integration | `pnpm test:browser` | ❌ Wave 0 |
| INT-10 | SQL error rejects with descriptive message | integration | `pnpm test:browser` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm test` (existing Node unit tests — fast gate)
- **Per wave merge:** `pnpm test && pnpm test:browser` (full suite)
- **Phase gate:** Full suite green before verification

### Wave 0 Gaps
- [ ] `pnpm add -D @rstest/browser playwright` — install missing devDependencies
- [ ] `rstest.browser.config.ts` — browser config with Playwright + COOP/COEP headers
- [ ] `tests/browser/helpers.ts` — `createTestClient()` helper
- [ ] Add `"test:browser": "rstest --config rstest.browser.config.ts"` to `package.json` scripts
- [ ] Empirically verify `server.headers` key is accepted by Rstest config (or use `modifyLibConfig` fallback)

---

## Open Questions

1. **`server.headers` key in Rstest config TypeScript types**
   - What we know: D-04 states headers go via Rsbuild `server.headers`. The Rsbuild docs confirm this key exists. The Rstest config TypeScript types reviewed don't explicitly expose `server` as a top-level key in `RstestConfig`.
   - What's unclear: Whether TypeScript will accept `server.headers` in `rstest.browser.config.ts` or whether it must go through `withRslibConfig({ modifyLibConfig: ... })`.
   - Recommendation: Wave 0 implementer should try the direct `server: { headers: ... }` form first. If TypeScript rejects it, use `modifyLibConfig` fallback. Both should produce the same runtime effect.

2. **Worker URL resolution in browser test context**
   - What we know: `client.ts` uses `new URL('./worker.ts', import.meta.url)` to spawn workers. In a browser test, `import.meta.url` points to the dev server URL for the module.
   - What's unclear: Whether `@rstest/adapter-rslib` + Rsbuild correctly bundles and serves the worker chunk so this URL resolves properly in the browser test environment.
   - Recommendation: The first Wave 0 task should verify this with the `createSQLiteClient` smoke test (INT-02). If the URL fails, the worker will not initialize and the test will time out.

3. **`generate_series` availability in wa-sqlite v1.0.9**
   - What we know: `generate_series` is an optional SQLite extension. wa-sqlite ships WASM builds with a subset of extensions.
   - What's unclear: Whether wa-sqlite v1.0.9 includes `generate_series` in any of the three WASM modules it uses.
   - Recommendation: Use explicit INSERT loop (100–1000 rows) for the AbortSignal test setup. This is reliable regardless of extension availability.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Standalone `playwright test` | Rstest browser mode (`@rstest/browser`) | Rstest 0.8.0 (2026-01) | Same `describe`/`it`/`expect` API; no separate test runner |
| `JSDOM` / `happy-dom` for browser simulation | Real Chromium via `@rstest/browser` | Rstest 0.8.0 (2026-01) | OPFS, SharedArrayBuffer, Web Workers: all require real browser |

**Deprecated/outdated:**
- Running integration tests against a fake DOM (JSDOM): OPFS and SharedArrayBuffer are not available in JSDOM/happy-dom. Real Chromium is required.
- `npx playwright install` as a separate step: `@rstest/browser` handles Chromium download automatically.

---

## Sources

### Primary (HIGH confidence)
- `rstest.rs/guide/browser-testing/getting-started` — browser mode installation and config structure (direct WebFetch)
- `github.com/web-infra-dev/rstest` (raw config.ts) — `BrowserModeConfig` TypeScript types; confirmed `provider: 'playwright'` is the only option
- `raw.githubusercontent.com/web-infra-dev/rstest/main/examples/browser-react/rstest.config.ts` — official example config with `browser.enabled: true`, `provider: 'playwright'`
- `rsbuild.rs/config/server/headers` — `server.headers` accepts `Record<string, string>` and passes headers to all dev server responses (WebFetch confirmed)
- Project source files: `src/client.ts`, `src/worker.ts`, `src/orchestrator.ts`, `src/types.ts` — direct code read

### Secondary (MEDIUM confidence)
- `npm view @rstest/browser version` → `0.9.4` (confirmed current on 2026-03-24)
- `npm view playwright version` → `1.58.2` (confirmed current on 2026-03-24)
- `rstest.rs/guide/browser-testing/` — browser mode overview (WebFetch; confirms Playwright + real browser approach)
- Phase 2 CONTEXT.md D2 — documents that `lock()` blocking deferred to Phase 3 and must be tested in browser

### Tertiary (LOW confidence)
- CONTEXT.md D-04 assertion that `server.headers` is accessible via `withRslibConfig()` in rstest config — plausible given Rsbuild integration architecture, but not verified against Rstest TypeScript config types

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions confirmed from npm registry; official example config verified from GitHub
- Architecture: MEDIUM — patterns derived from code reading + official docs; `server.headers` mechanism has LOW-confidence verification
- Pitfalls: HIGH — derived from direct source code analysis (SharedArrayBuffer in orchestrator constructor, lock/unlock in worker.ts) + OPFS persistence characteristics

**Research date:** 2026-03-24
**Valid until:** 2026-04-24 (Rstest is in active development; minor API changes possible)
