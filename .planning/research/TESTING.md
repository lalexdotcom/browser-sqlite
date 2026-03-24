# Testing Research: wsqlite

**Domain:** Browser-only TypeScript library — SQLite worker pool with Web Workers, SharedArrayBuffer, WASM
**Researched:** 2026-03-24
**Overall confidence:** MEDIUM-HIGH (codebase read directly; Rstest internals inspected from installed packages; web search denied, so cross-referencing against installed package evidence and deep knowledge of this ecosystem)

---

## 1. What the Codebase Actually Is

Before testing strategy, understand what each module does:

| Module | Nature | Testable in Node? |
|--------|--------|-------------------|
| `utils.ts` — `isWriteQuery`, `sqlParams` | Pure functions, no browser deps | YES — pure unit tests |
| `debug.ts` — `debugSQLQuery`, `statusToLabel` | Pure functions + closures, no browser deps | YES |
| `orchestrator.ts` — `WorkerOrchestrator` | Uses `SharedArrayBuffer`, `Atomics` | YES in Node (SAB available since Node 15.4 with `--experimental-worker`) |
| `types.ts` | Type definitions only | N/A |
| `worker.ts` — the SQLite Worker | Uses OPFS, wa-sqlite WASM, `self.postMessage`, Worker context | NO — browser only |
| `client.ts` — `createSQLiteClient` | Uses `new Worker(...)`, PostMessage protocol, browser APIs | NO — browser only |

The split is clean. About 20% of the code is pure logic, 80% is browser-platform-coupled.

---

## 2. Rstest Capabilities (from inspecting installed v0.9.4)

### What Rstest supports

Rstest (`@rstest/core` v0.9.4) is built on Rsbuild/Rspack. From its package.json and type definitions:

**Test environments:**
- `node` (default) — runs in Node.js via tinypool workers
- `jsdom` — peer dependency, optional
- `happy-dom` — peer dependency, optional

**Browser mode:** EXISTS and is typed. Config key is `browser` in `defineConfig`. Supports:
```typescript
browser: {
  enabled: true,
  provider: 'playwright',       // only supported provider
  browser: 'chromium' | 'firefox' | 'webkit',
  headless: true,
  port?: number,
  providerOptions?: Record<string, unknown>,
}
```

The `@rstest/core` package.json has no `playwright` peer dependency listed, which means **Playwright must be installed separately**. The `browser` export (`@rstest/core/browser`) and `browser-runtime` export exist in the dist, confirming the browser mode is a real implemented feature.

### What Rstest cannot do for this library

- **JSDOM/happy-dom do not implement Web Workers, SharedArrayBuffer, or OPFS.** These are stub/partial browser environments. Running `createSQLiteClient` in jsdom will throw immediately when trying `new Worker(...)`.
- **Node.js mode** can test `WorkerOrchestrator` directly because Node has `SharedArrayBuffer` and `Atomics`, but cannot run the worker's WASM or VFS code.
- **WASM in Node** — wa-sqlite's `.mjs` files are browser ESM modules using `fetch` and browser APIs internally. They will not work in Node without significant shims.

---

## 3. Testing Strategy: Two-Layer Architecture

```
Layer 1: Rstest Node mode   — pure functions, orchestrator logic, type contracts
Layer 2: Playwright browser  — worker pool, WASM, OPFS, real SQLite operations
```

Do not try to squeeze browser behavior into Layer 1. The cost of fighting the environment is higher than the benefit.

---

## 4. Layer 1: Unit Tests with Rstest (Node mode)

### What goes here

**`isWriteQuery` (utils.ts)** — Pure regex function. Test every branch:
```typescript
// These should be testable today with zero setup changes
import { isWriteQuery } from '../src/utils';

test('detects INSERT', () => expect(isWriteQuery('INSERT INTO t VALUES (?)')).toBe(true));
test('detects SELECT as read', () => expect(isWriteQuery('SELECT * FROM t')).toBe(false));
test('BEGIN is not a write', () => expect(isWriteQuery('BEGIN')).toBe(false));
test('COMMIT is not a write', () => expect(isWriteQuery('COMMIT')).toBe(false));
// Edge cases worth testing:
test('lowercase insert', () => expect(isWriteQuery('insert into t values (?)')).toBe(true));
test('CREATE TABLE', () => expect(isWriteQuery('CREATE TABLE t (id INTEGER)')).toBe(true));
test('REPLACE INTO', () => expect(isWriteQuery('REPLACE INTO t VALUES (?)')).toBe(true));
```

**Bug to be aware of:** `isWriteQuery` currently routes `BEGIN`, `COMMIT`, `ROLLBACK` as reads (the regex won't match). This is intentional — transactions use the `read` path in `client.ts` for coordination. Any test asserting otherwise would be wrong. Confirm this intent before writing tests.

**`sqlParams` (utils.ts)** — Pure function. Tests:
```typescript
test('deduplicates repeated values', () => {
  const p = sqlParams();
  expect(p.addParam('foo')).toBe('?001');
  expect(p.addParam('foo')).toBe('?001');  // same index, deduplicated
  expect(p.addParam('bar')).toBe('?002');
  expect(p.params).toEqual(['foo', 'bar']);
});
```

**`debugSQLQuery` (debug.ts)** — String interpolation with edge cases. Pure. Test with positional params (`?001`), simple params (`?`), string literals with embedded `?`, `NULL` handling, date formatting.

**`WorkerOrchestrator` (orchestrator.ts)** — Uses `SharedArrayBuffer` and `Atomics`. Node.js has both. Tests run in Node mode without issue:

```typescript
import { WorkerOrchestrator, WorkerStatuses } from '../src/orchestrator';

test('initializes all workers as EMPTY', () => {
  const o = new WorkerOrchestrator(3);
  expect(o.getStatus(0)).toBe(WorkerStatuses.EMPTY);
  expect(o.getStatus(1)).toBe(WorkerStatuses.EMPTY);
  expect(o.getStatus(2)).toBe(WorkerStatuses.EMPTY);
});

test('setStatus updates atomically', () => {
  const o = new WorkerOrchestrator(2);
  expect(o.setStatus(0, WorkerStatuses.READY)).toBe(true);
  expect(o.getStatus(0)).toBe(WorkerStatuses.READY);
});

test('setStatus with from guard rejects wrong current status', () => {
  const o = new WorkerOrchestrator(2);
  // Worker is EMPTY, try to CAS from RUNNING — should fail
  const result = o.setStatus(0, WorkerStatuses.DONE, WorkerStatuses.RUNNING);
  expect(result).toBe(false);
  expect(o.getStatus(0)).toBe(WorkerStatuses.EMPTY);
});

test('lock/unlock cycle', () => {
  const o = new WorkerOrchestrator(1);
  // lock() will acquire immediately (FREE state)
  o.lock();
  // unlock() should release without throwing
  o.unlock();
  // Can lock again
  o.lock();
  o.unlock();
});

test('can accept SharedArrayBuffer from another orchestrator', () => {
  const source = new WorkerOrchestrator(2);
  source.setStatus(0, WorkerStatuses.READY);
  const copy = new WorkerOrchestrator(source.sharedArrayBuffer);
  expect(copy.getStatus(0)).toBe(WorkerStatuses.READY);
  expect(copy.size).toBe(2);
});
```

**Caution with `lock()`:** `Atomics.wait()` is not allowed on the main thread in browsers, but IS allowed in Node. In tests, do not call `lock()` twice from the same synchronous context without a thread to release — it will deadlock. The lock test above is safe because we don't block.

### Rstest configuration for Node-mode unit tests

The current `rstest.config.ts` is minimal:
```typescript
import { withRslibConfig } from '@rstest/adapter-rslib';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  extends: withRslibConfig(),
});
```

This works for Node-mode tests. No changes needed to test pure functions and `WorkerOrchestrator`.

To keep browser tests separate, add a `testMatch` pattern:
```typescript
export default defineConfig({
  extends: withRslibConfig(),
  testMatch: ['**/*.unit.test.ts'],  // unit tests in Node
});
```

And a separate config for browser tests (see Section 6).

---

## 5. Layer 2: Integration Tests with Playwright

### Why Playwright, not Rstest browser mode

Rstest browser mode (via Playwright) runs test files IN the browser using an injected runner. This is excellent for component-style tests. However, it has a constraint: **the test file itself runs in the browser context**, which means you must write tests using browser APIs directly, and the dev server needs to serve the built files correctly with proper headers.

For wsqlite, the test goal is: "does the complete client ↔ worker ↔ WASM pipeline work end to end?" Playwright's direct test API (`page.evaluate`, `page.addScriptTag`, `page.exposeFunction`) gives more surgical control over the browser context.

**Use Rstest browser mode for:** pure in-browser unit tests where you want the same `describe`/`test` API.
**Use Playwright directly for:** integration tests of the full pipeline where you need control over headers, Worker URLs, WASM loading, and OPFS state between tests.

Both approaches require Playwright. The difference is who drives the test runner.

### The SharedArrayBuffer / OPFS header requirement

SharedArrayBuffer is only available when the page is cross-origin isolated. This requires:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Without these headers, `new SharedArrayBuffer(...)` throws a `SecurityError`.**

This is the single most common failure mode when first setting up these tests.

In Playwright, set headers on the test server:
```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'npm run serve:test',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

```typescript
// test-server.ts (serve built files with COOP/COEP headers)
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const server = createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  // serve static files from dist/ ...
});
```

Or use a build tool plugin (Rsbuild has a `server.headers` option) that adds these headers during the dev server.

**OPFS** does not require additional permissions beyond COOP/COEP. It is available in all dedicated Worker contexts in Chromium, Firefox (since 111), and Safari (since 15.2). Playwright's Chromium will have OPFS available.

### What to actually test in Playwright

```typescript
// tests/integration/client.test.ts (run via Playwright)

test('createSQLiteClient initializes worker pool', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createSQLiteClient } = await import('/dist/esm/index.js');
    const db = createSQLiteClient('test.db', { poolSize: 2, vfs: 'IDBBatchAtomicVFS' });
    const rows = await db.read('SELECT 1 as n');
    db.close();
    return rows;
  });
  expect(result).toEqual([{ n: 1 }]);
});

test('read/write/read roundtrip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createSQLiteClient } = await import('/dist/esm/index.js');
    const db = createSQLiteClient('roundtrip.db', { vfs: 'IDBBatchAtomicVFS' });
    await db.write('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)');
    await db.write('INSERT INTO items (name) VALUES (?)', ['hello']);
    const rows = await db.read('SELECT * FROM items');
    db.close();
    return rows;
  });
  expect(result).toEqual([{ id: 1, name: 'hello' }]);
});

test('transaction rolls back on error', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createSQLiteClient } = await import('/dist/esm/index.js');
    const db = createSQLiteClient('tx.db', { vfs: 'IDBBatchAtomicVFS' });
    await db.write('CREATE TABLE IF NOT EXISTS t (id INTEGER)');
    try {
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        throw new Error('intentional');
      });
    } catch {}
    const rows = await db.read('SELECT * FROM t');
    db.close();
    return rows;
  });
  expect(result).toEqual([]);
});

test('pool queues concurrent reads', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { createSQLiteClient } = await import('/dist/esm/index.js');
    const db = createSQLiteClient('concurrent.db', { poolSize: 2, vfs: 'IDBBatchAtomicVFS' });
    // Fire 4 concurrent reads at a 2-worker pool — should all resolve
    const results = await Promise.all([
      db.read('SELECT 1 as n'),
      db.read('SELECT 2 as n'),
      db.read('SELECT 3 as n'),
      db.read('SELECT 4 as n'),
    ]);
    db.close();
    return results.map(r => r[0].n);
  });
  expect(result).toEqual([1, 2, 3, 4]);
});
```

### VFS selection in tests

**Use `IDBBatchAtomicVFS` for integration tests**, not `OPFSPermutedVFS` or `OPFSCoopSyncVFS`.

Reasons:
- `IDBBatchAtomicVFS` works in all contexts including Window — simpler to serve from a test HTML page
- No COOP/COEP requirement (confirmed in wa-sqlite README)
- Uses IndexedDB which Playwright fully supports
- Resets cleanly: call `indexedDB.deleteDatabase('test.db')` in `afterEach`

`OPFSPermutedVFS` (the production default) requires:
- Dedicated Worker context (worker.ts, not the test page)
- `FileSystemSyncAccessHandle` with `readwrite-unsafe` mode — only Chromium
- More complex cleanup (must delete OPFS files between tests)

For CI-safe, cross-browser-possible tests, use `IDBBatchAtomicVFS`. Add a separate `OPFSPermutedVFS` test suite flagged as `chromium-only`.

### OPFS cleanup between tests

```typescript
// playwright setup helper
async function clearOPFS(page) {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true });
    }
  });
}

// IDB cleanup
async function clearIDB(page, dbName) {
  await page.evaluate(async (name) => {
    await new Promise((res, rej) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = res;
      req.onerror = rej;
    });
  }, dbName);
}
```

---

## 6. WASM Testing Patterns

### Option A: Test with real WASM binary (recommended)

wa-sqlite ships prebuilt `.wasm` files in `node_modules/wa-sqlite/dist/`. These work in a real Chromium context. The Playwright test server must serve them with `application/wasm` content-type and COOP/COEP headers.

**No mocking needed.** The WASM binary is stable, deterministic, and small enough (the sync build `wa-sqlite.wasm` is ~1.7MB) that loading it in tests is practical.

The async build `wa-sqlite-async.wasm` (used by `OPFSPermutedVFS` and `IDBBatchAtomicVFS`) is ~2.5MB due to Asyncify instrumentation. Still tractable.

### Option B: Mock wa-sqlite (avoid unless forced)

Mocking wa-sqlite means implementing a fake `sqlite-api.js` `Factory` that returns a mock `sqlite` object with methods like `statements`, `bind_collection`, `column_names`, `step`, `row`, `changes`. This is a substantial amount of work and creates a mock that drifts from real behavior.

**The only valid reason to mock wa-sqlite:** testing worker error-handling paths that are hard to trigger with real SQLite (e.g., what happens when `sqlite.step()` throws). Even then, prefer using real SQLite with SQL that causes errors (`INSERT INTO nonexistent_table`).

### Option C: MemoryVFS for isolated worker tests

`MemoryVFS` and `MemoryAsyncVFS` from wa-sqlite ship as JavaScript files, not requiring OPFS or IDB. They work in any browser context with a real WASM module. However, wsqlite's `worker.ts` only supports the named VFS types in `VFSConfigs`. A test VFS config would need to be added to `worker.ts` or the VFS list needs to be made extensible.

**Recommendation:** Add `MemoryVFS` as a `SQLiteVFS` option (type + VFSConfig entry) specifically for testing. It uses the synchronous wa-sqlite build which is fastest and has no external storage dependencies.

```typescript
// Proposed addition to worker.ts VFSConfigs for test use:
MemoryVFS: {
  fs: () => import('wa-sqlite/src/examples/MemoryVFS.js'),
  module: WA_SQLITE_MODULES.wa_sqlite,  // synchronous build — fastest
},
```

With this, integration tests using `vfs: 'MemoryVFS'` would:
- Require no IDB or OPFS cleanup
- Load the smallest/fastest WASM build
- Be completely deterministic (no storage state leaks between tests)

---

## 7. Worker Pool Logic — What to Test and How

The worker pool logic in `client.ts` manages state that is hard to observe from outside. Here is what to test and how:

### Worker acquisition / queuing

The pool is initialized asynchronously. Tests must wait for initialization before issuing queries. The current API has no `ready` or `initialized` promise exposed — the first `read()` call will block until workers are ready (they queue internally via `deferredInit`).

**Pattern:** Issue a trivial query as the first operation to synchronize:
```typescript
const db = createSQLiteClient('test.db', { vfs: 'MemoryVFS' });
await db.read('SELECT 1');  // blocks until at least one worker is ready
```

### Writer stickiness

The pool designates a writer worker (`currentWriterIndex`) to prevent write conflicts. Test:
- After a write, subsequent writes go to the same worker
- After the writer releases, a new write can use any worker
- Interleaved reads and writes don't deadlock

These require the debug state (`clientOptions.debug: true`) to inspect `debug.workers[i].currentRequest`. The debug object is returned from `createSQLiteClient` and provides introspection into worker state — use it in tests.

### The `isWriteQuery` routing bug risk

`client.ts` routes queries by calling `isWriteQuery(sql)`. If `isWriteQuery` has a false negative (says write is a read), a write goes to a reader worker and could conflict. Tests should cover:
- `BEGIN` / `COMMIT` / `ROLLBACK` go through the read path (tested at unit level)
- `CREATE TABLE` goes through the write path
- Inside a transaction, the same worker is used for all operations

### Abort signal

Test that `AbortSignal` cancels streaming mid-result:
```typescript
const controller = new AbortController();
const gen = db.stream('SELECT * FROM large_table', [], { signal: controller.signal });
const firstChunk = await gen.next();
controller.abort();
// After abort, orchestrator status should be ABORTING -> DONE
// No more chunks should be delivered
```

### Pool size constraint for AccessHandlePoolVFS

This is already guarded in `createSQLiteClient`:
```typescript
if (vfs === 'AccessHandlePoolVFS' && poolSize > 1) {
  throw new Error('AccessHandlePoolVFS does not support pool sizes greater than 1');
}
```

This is a pure synchronous throw — testable in Node mode without a browser:
```typescript
test('AccessHandlePoolVFS rejects poolSize > 1', () => {
  // Note: Worker constructor will fail in Node, but the guard throws before
  // any Worker is created IF we can intercept
  // Problem: Worker() constructor is called lazily inside createWorker()
  // The guard IS at the top of createSQLiteClient, before Workers are created
  expect(() =>
    createSQLiteClient('test.db', { vfs: 'AccessHandlePoolVFS', poolSize: 2 })
  ).toThrow('AccessHandlePoolVFS does not support pool sizes greater than 1');
});
```

This test will fail in Node because `createSQLiteClient` imports `WorkerOrchestrator` which is fine in Node, but the `Worker` constructor is accessed via `import.meta.url`. Check if this import path resolves in Node's ESM. If not, mock `Worker` at the module level.

---

## 8. Rstest Browser Mode vs Standalone Playwright — Decision

| Concern | Rstest browser mode | Standalone Playwright |
|---------|--------------------|-----------------------|
| Test syntax | `@rstest/core` (familiar) | `@playwright/test` (different API) |
| Server control | Limited — uses Rsbuild dev server | Full — custom server with headers |
| COOP/COEP headers | Need rsbuild plugin to add headers | Easy via `webServer` + custom server |
| Worker URL resolution | `import.meta.url` → needs bundler support | Static file serving, easier |
| Debugging | Rstest UI + Playwright traces | Playwright traces only |
| Test isolation (IDB/OPFS cleanup) | Possible via `beforeEach`/`afterEach` in test file | Same |
| CI integration | One command | One command |

**Recommendation:** Use Rstest browser mode for the integration tests, because it keeps one test runner. Configure Rsbuild (which Rstest browser mode uses internally) to add COOP/COEP headers. The `plugins` field in `RstestConfig` accepts Rsbuild plugins, which can inject server headers.

```typescript
// rstest.browser.config.ts
import { defineConfig } from '@rstest/core';

export default defineConfig({
  testMatch: ['**/*.browser.test.ts'],
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  plugins: [
    {
      name: 'coop-coep-headers',
      setup(api) {
        api.modifyRsbuildConfig((config) => {
          config.server ??= {};
          config.server.headers = {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          };
        });
      },
    },
  ],
});
```

If Rstest browser mode has trouble serving the Worker script (the `new Worker(new URL('./worker.ts', import.meta.url))` pattern may not resolve correctly in Rsbuild's dev server), fall back to standalone Playwright with a pre-built dist.

---

## 9. File Structure

```
tests/
  unit/
    utils.test.ts           # isWriteQuery, sqlParams — Node mode
    debug.test.ts           # debugSQLQuery, statusToLabel — Node mode
    orchestrator.test.ts    # WorkerOrchestrator — Node mode (SAB works in Node)
  browser/
    client.browser.test.ts  # Full pipeline, reads/writes/streams — browser mode
    pool.browser.test.ts    # Concurrency, queuing, writer stickiness — browser mode
    transaction.browser.test.ts  # Transaction commit/rollback — browser mode
    stream.browser.test.ts  # Abort signals, streaming — browser mode
  helpers/
    cleanup.ts              # clearOPFS(), clearIDB() helpers
    fixtures.ts             # Standard DB setup (CREATE TABLE, seed data)

rstest.config.ts            # Node mode (existing) — unit tests
rstest.browser.config.ts    # Browser mode — integration tests
playwright.config.ts        # (optional) if standalone Playwright is used
```

---

## 10. Critical Gotchas

### SharedArrayBuffer availability

Node.js 20+ has `SharedArrayBuffer` available by default (no flag needed). Node 16-19 required `--experimental-vm-modules` and certain security contexts. The package.json engine constraint (`"node": "^20.19.0 || >=22.12.0"`) means this is safe.

In the browser, SAB requires COOP/COEP. Without these headers, `new SharedArrayBuffer(...)` throws a `SecurityError` at the `WorkerOrchestrator` constructor. This is the most common first-run failure.

### `Atomics.wait()` on main thread

`Atomics.wait()` is forbidden on the browser main thread. It will throw `TypeError: Atomics.wait cannot be called in the main thread`. The `WorkerOrchestrator.lock()` method calls `Atomics.wait()`. The orchestrator is used in `worker.ts` (Worker context — fine) and its `setStatus`/`getStatus` in `client.ts` (main thread — fine, those use `Atomics.compareExchange`/`Atomics.exchange`/`Atomics.load`, all allowed on main thread).

The `lock()` / `unlock()` methods on the orchestrator should NOT be called from tests running on the main thread. Testing `lock()` in Node (where there's no main thread restriction) is safe.

### `import.meta.url` Worker construction

```typescript
new Worker(new URL('./worker.ts', import.meta.url), { name: workerName })
```

This pattern requires a bundler that resolves `./worker.ts` relative to the current module at build time. Rsbuild/Rspack handles this. In tests:
- Node mode: This will likely throw because Node cannot load the Worker via this URL pattern without bundling. Mock `Worker` in unit tests.
- Browser mode: Rsbuild serves the built worker file; URL resolution works if the bundler handles worker splitting.

### WASM loading in workers

wa-sqlite's WASM files are loaded via dynamic `import()` inside the worker. The worker must be served from the same origin (or with CORS headers) as the WASM files. In Playwright, ensure the test server serves both the app bundle and the WASM files.

### Test isolation for OPFS-based VFS

OPFS is persistent across page reloads within the same origin. If a test creates files in OPFS and fails before cleanup, subsequent tests see stale data. Always clean up in `afterEach`:
```typescript
afterEach(async () => {
  await clearOPFS(page);
});
```

For IDB-based VFS (`IDBBatchAtomicVFS`, `IDBMirrorVFS`), delete the named database after each test.

### `MemoryVFS` not exposed in current `SQLiteVFS` type

The current `types.ts` `SQLiteVFS` union and `worker.ts` `VFSConfigs` do not include `MemoryVFS`. To use it in tests, either:
1. Add it as a proper VFS option (recommended — small change, big test value)
2. Use `IDBBatchAtomicVFS` as the test VFS (available today, requires IDB cleanup)

### wa-sqlite has no TypeScript types

`worker.ts` has `// @ts-expect-error` on all wa-sqlite imports. Tests that import wa-sqlite directly will need the same suppression. This is known and expected.

### `@lalex/promises` `defer()` dependency

`client.ts` and `orchestrator.ts` import from `@lalex/promises`. This package is not in `package.json` but is used in `client.ts`. Check if it's a transitive dependency or a missing devDependency. Tests that instantiate `client.ts` will fail if this import cannot resolve.

Looking at `client.ts` line 1-2: it imports `defer` from `@lalex/promises`. This package is not in `devDependencies` or `dependencies` in `package.json`. Either it is available via the `@lalex/console` transitive tree, or it is missing and currently untested code would fail at import time.

---

## 11. Recommended Test Stack

| Package | Purpose | Version |
|---------|---------|---------|
| `@rstest/core` (already installed) | Unit test runner | 0.9.4 |
| `@rstest/adapter-rslib` (already installed) | Rslib config bridge | 0.2.1 |
| `playwright` | Browser automation | ^1.50.0 |
| `@playwright/test` | Playwright test API (if using standalone) | ^1.50.0 |

No additional test libraries needed. Do not add Jest, Vitest, or other test runners — they overlap with Rstest and add toolchain complexity.

---

## 12. What Not To Do

**Do not use jsdom or happy-dom for browser tests.** Neither implements Web Workers, SharedArrayBuffer, or OPFS. They will silently skip or throw on the first browser API call.

**Do not mock `WorkerOrchestrator` for integration tests.** The SharedArrayBuffer-based locking is the feature being tested. Using a fake orchestrator would make integration tests meaningless.

**Do not try to run `worker.ts` logic directly in Node tests.** The worker imports WASM modules via dynamic `import()` paths that resolve to browser ESM files using `fetch`. In Node without special configuration, these imports fail.

**Do not test with `OPFSPermutedVFS` (the production default) in CI** unless you verify Playwright's Chromium supports `FileSystemSyncAccessHandle` with `readwrite-unsafe` locking mode. As of mid-2024 this was Chromium-only and not universally available. Use `IDBBatchAtomicVFS` in CI.

**Do not snapshot worker message sequences.** The message protocol (chunk/done/error) is an internal detail. Test the public API result (`db.read()`, `db.write()`, etc.), not the wire protocol. Wire protocol tests break on any refactor and provide no user-facing value.
