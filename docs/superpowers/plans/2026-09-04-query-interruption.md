# Query interruption — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `signal` stops a `sqlite3_step()` that is already running, and a new per-query
`timeout` bounds how much engine time a query may spend.

**Architecture:** `sqlite3_progress_handler` is installed on the connection for the duration
of a query that carries a `signal` or a `timeout`, and removed afterwards. It runs on the
worker's own thread inside `step()` every `N = 100_000` VM instructions; a non-zero return
ends the statement with `SQLITE_INTERRUPT`. Its shape depends on what the query carries: a
synchronous handler reading the clock (timeout, every build), an `async` handler that yields
a task so a queued `stop` message can land (signal, `async`/`jspi`), or a synchronous handler
reading an `Atomics` slot (signal, `sync` build under cross-origin isolation).

**Tech Stack:** TypeScript, wa-sqlite (three builds), Web Workers, `SharedArrayBuffer` +
`Atomics`, rstest browser projects on Chromium and Firefox, biome.

**Spec:** `docs/superpowers/specs/2026-09-04-query-interruption-design.md` — read it first;
this plan argues from it and does not repeat its rationale.

## Global Constraints

- **Every commit must land green.** The pre-commit hook runs `npx lint-staged && pnpm test
  && pnpm exec tsc --noEmit`, so a commit holding only a failing test is refused. Each task
  below therefore commits the test and the code that satisfies it together. Run the test and
  watch it fail BEFORE writing the implementation — the RED step is real, it just is not a
  commit.
- **`pnpm check` (biome) after every modification.** Baseline is 97 files, 13 warnings,
  1 info; a new warning is yours.
- **Serena's symbolic tools are primary for code.** `find_symbol` / `replace_symbol_body` /
  `replace_content`, not Read/Edit, on any `.ts`. Markdown and JSON are exempt.
- **`N = 100_000`**, one internal constant named `PROGRESS_OPS`, in `src/worker/worker.ts`.
  Not an option, not exported.
- **Do NOT add `SharedArrayBuffer`, `Atomics` or `crossOriginIsolated` to the API list read
  by `LIB_FLOOR` in `scripts/render-vfs-matrix.ts`.** They are used only behind a probe;
  adding them raises the published floor for an optional capability (spec §5 D3).
- **French in chat, English in code, comments, commits and docs.**
- Chat language and workflow rules: `AGENTS.md`. Conventions this repository has paid for:
  `mem:conventions`.

---

### Task 1: `timeout`, its error, and the synchronous execution clock

Delivers a working `timeout` on all three builds, with no isolation and no
`SharedArrayBuffer`. This is the whole feature for the `sync` build.

**Files:**
- Modify: `src/errors.ts` — add `QUERY_TIMEOUT` to `SQLiteErrorCode` and to the header comment
- Modify: `src/api.ts:48` (`SQLiteQueryOptions`) and `src/api.ts:58` (`SQLiteChunkOptions`)
- Modify: `src/types.ts:20-24` (`SQLOptions`), and the `error` reply in `ClientMessageData`'s
  sibling union (`type: 'error'`, around `src/types.ts:91`)
- Modify: `src/pool.ts:13` (`PoolWorkerQueryOptions`), `src/pool.ts:93` (`workerError`),
  and the `postMessage({ type: 'query', … })` call around `src/pool.ts:407`
- Modify: `src/queries.ts:44` (`chunk`, destructure and forward `timeout`)
- Modify: `src/worker/worker.ts:39` (`SQLOptions`), and `query()` around `src/worker/worker.ts:280`
- Test: `tests/browser/query-timeout.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `timeout?: number` on `SQLiteQueryOptions` and `SQLiteChunkOptions`;
  `'QUERY_TIMEOUT'` in `SQLiteErrorCode`; `errorCode?: SQLiteErrorCode` on the worker's
  `error` reply; the constant `PROGRESS_OPS = 100_000` in `src/worker/worker.ts`; and in
  `query()` the two locals `spent` and `stepStart` that Task 2 reads.

- [ ] **Step 1: Write the failing tests**

`tests/browser/query-timeout.test.ts`. `createTestClient` and `longQuery` come from
`tests/browser/helpers.ts` — there is no `withClient` wrapper in this repository, and every
test closes its own client.

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

describe('query timeout', () => {
  it('rejects with QUERY_TIMEOUT and leaves the client usable', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS' });
    try {
      const started = performance.now();
      await expect(
        db.read(longQuery(20_000_000), [], { timeout: 200 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
      // The statement really stopped: nowhere near the seconds it would run.
      expect(performance.now() - started).toBeLessThan(1500);
      // And the connection still works.
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('spends the budget over the whole call, not per statement', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS' });
    try {
      // Two statements, each shorter than the budget, whose sum is not.
      const half = `${longQuery(8_000_000)};`;
      await expect(
        db.write(`${half} ${half}`, [], { timeout: 400 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  it('does not charge the consumer for its own slowness', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS' });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (1), (2), (3)');
      const seen: number[] = [];
      // The budget is 100 ms of ENGINE time; the consumer sleeps far longer
      // than that between rows and must not be timed out for it.
      for await (const row of db.stream<{ a: number }>('SELECT a FROM t', [], {
        timeout: 100,
        chunkSize: 1,
      })) {
        await new Promise((r) => setTimeout(r, 80));
        seen.push(row.a);
      }
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

```bash
pnpm exec rstest --project chromium run tests/browser/query-timeout.test.ts
```

Expected: failures on the unknown option / no rejection. Do NOT commit here — the hook
refuses a red tree.

- [ ] **Step 3: Add the error code**

`src/errors.ts` — add to the union and one sentence to the header comment:

```ts
  | 'QUERY_TIMEOUT'
```

```
 * `QUERY_TIMEOUT` is the `timeout` a caller set on a query being spent. It is
 * deliberately not `TIMEOUT`, which means a deadline this library imposed on
 * itself — a worker that never became ready, a deletion that did not complete.
```

- [ ] **Step 4: Widen the option types**

`src/api.ts`:

```ts
/** Options every query method accepts. */
export type SQLiteQueryOptions = OptionsWithSignal<{
  /**
   * Milliseconds of SQLite EXECUTION this query may spend before it is stopped
   * and rejected with `QUERY_TIMEOUT`. Time the caller spends between two
   * chunks of a `stream()` is not charged to it — for a wall-clock deadline,
   * pass `AbortSignal.timeout(ms)` as `signal` instead. See the README's
   * Interrupting a query section.
   */
  timeout?: number;
}>;
```

Add the same member (same comment) to `SQLiteChunkOptions`'s object at `src/api.ts:58`.
`OptionsWithSignal` itself does not change: `transaction()`, `bulkWrite()` and `output()`
must NOT gain a `timeout` (spec §2).

`src/types.ts` — the internal `SQLOptions` at line 20 gains `timeout?: number;`, and the
`type: 'error'` reply gains:

```ts
      /** A code this library minted, when the worker knows the cause. */
      errorCode?: SQLiteErrorCode;
```

`src/pool.ts` — `PoolWorkerQueryOptions` gains `timeout?: number | undefined;`, and
`workerError` mints it before falling through:

```ts
const workerError = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
  errorCode?: SQLiteErrorCode;
}) =>
  (data.errorCode
    ? new SQLiteError(data.errorCode, data.message, { cause: data.cause })
    : undefined) ??
  busyFromCode(data) ??
  new Error(data.message, { cause: data.cause });
```

- [ ] **Step 5: Forward the option to the worker**

`src/queries.ts` in `chunk()`:

Two lines change, and nothing between them:

```ts
  // was: const { signal, chunkSize, credits } = options ?? {};
  const { signal, chunkSize, credits, timeout } = options ?? {};

  // was: const iterator = worker.query<T>(sql, params, { chunkSize, credits });
  const iterator = worker.query<T>(sql, params, { chunkSize, credits, timeout });
```

`src/pool.ts`, in the `query` generator: destructure `timeout` from `options` beside
`chunkSize` and `credits`, and put it in the posted message's `options`.

- [ ] **Step 6: Install the handler in the worker**

`src/worker/worker.ts`. Add the constant near `DEFAULT_CREDIT_WINDOW`'s import site:

```ts
/**
 * VM instructions between two progress-handler calls. Measured 2026-09-04 on
 * Chromium 151 and Firefox 153: at this value the handler is free within noise
 * on every shape, and an abort overshoots by 1-6 ms. 10x coarser saves 2-4
 * points on pure computation and costs up to 87 ms on Firefox/async — the wrong
 * side of the trade. See the design's §4.3.
 */
const PROGRESS_OPS = 100_000;
```

In `query()`, before the cached/uncacheable/prepared branches, and wrapping all of them in a
`try/finally`:

```ts
    // The budget is EXECUTION time: only what is spent inside step() counts, so
    // a slow consumer of stream() is never charged for its own pauses. The
    // handler runs inside step(), so it adds the current step's elapsed time to
    // what earlier steps of this call accumulated.
    let spent = 0;
    let stepStart = 0;
    const { timeout } = options ?? {};
    if (timeout !== undefined) {
      sqlite.progress_handler(
        db,
        PROGRESS_OPS,
        () => (spent + (performance.now() - stepStart) > timeout ? 1 : 0),
        null,
      );
    }
```

and in the matching `finally`:

```ts
      if (timeout !== undefined) sqlite.progress_handler(db, 0, null, null);
```

In `run()`, bracket the step so the clock is real:

```ts
        stepStart = performance.now();
        const result = await sqlite.step(stmt);
        spent += performance.now() - stepStart;
```

- [ ] **Step 7: Translate `SQLITE_INTERRUPT` into the cause that fired**

Still in `run()`, wrap the step so an interrupt never reaches the caller as a SQLite code.
`SQLITE_INTERRUPT` is `9`; import it from `wa-sqlite/src/sqlite-constants.js` beside
`SQLITE_ROW`:

```ts
        stepStart = performance.now();
        let result: number;
        try {
          result = await sqlite.step(stmt);
        } catch (e) {
          spent += performance.now() - stepStart;
          if ((e as { code?: number })?.code === SQLITE_INTERRUPT) {
            // Two triggers can raise it, and only the worker knows which.
            if (gate.isStopped()) break; // the client already rejected
            throw new WorkerQueryTimeout(timeout as number);
          }
          throw e;
        }
        spent += performance.now() - stepStart;
```

with, at module scope:

```ts
/**
 * Carries the code across the postMessage boundary. The worker cannot import
 * SQLiteError — `src/errors.ts` is the consumer's surface and the worker bundle
 * does not need it — so the code travels as a field and `workerError` in
 * `src/pool.ts` mints the real error on the other side.
 */
class WorkerQueryTimeout extends Error {
  readonly errorCode = 'QUERY_TIMEOUT' as const;
  constructor(budget: number) {
    super(`Query exceeded its timeout of ${budget} ms of execution.`);
  }
}
```

and in the `catch` of the `query` message handler, relay it:

```ts
            ...(typeof (e as { errorCode?: unknown })?.errorCode === 'string'
              ? { errorCode: (e as { errorCode: SQLiteErrorCode }).errorCode }
              : {}),
```

- [ ] **Step 8: Run the tests on both engines**

```bash
pnpm exec rstest --project chromium run tests/browser/query-timeout.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/query-timeout.test.ts
pnpm check && pnpm exec tsc --noEmit
```

Expected: three tests passing on each engine, biome unchanged at 13 warnings / 1 info.

- [ ] **Step 9: Commit**

```bash
git add src/api.ts src/errors.ts src/types.ts src/pool.ts src/queries.ts src/worker/worker.ts tests/browser/query-timeout.test.ts
git commit -m "feat(query): a timeout that counts engine time, not wall clock"
```

---

### Task 2: `signal` stops a running statement on `async` and `jspi`

**Files:**
- Modify: `src/worker/worker.ts` — the handler's second shape
- Test: `tests/browser/interrupt.test.ts` (new)

**Interfaces:**
- Consumes: `PROGRESS_OPS`, `spent`, `stepStart` and the interrupt translation from Task 1.
- Produces: nothing new on the public surface. `db.read(..., { signal })` now stops the work.

The mechanism is small because the worker already learns about a stop: `src/pool.ts`'s
`interrupt()` posts `{type:'stop'}` and the worker's `onmessage` calls `gate.stop()`. What
was missing is a chance for that message to be delivered while `step()` runs. An `async`
handler that awaits `gate.tick()` — the gate's own `MessageChannel`, `src/credits.ts:34` —
gives the event loop exactly that turn. `gate.reset()` clears `stopped` per call, so no
state survives between queries.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

describe('aborting a running statement', () => {
  it('frees the worker, so the next query does not wait it out', async () => {
    // poolSize 1: the next query MUST land on the worker that was interrupted.
    const db = await createTestClient({ poolSize: 1 });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');

      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      // Before this change the short read waited ~1.9 s for the abandoned
      // statement. The threshold is an observation, not a specification:
      // widen it if slower CI hardware proves it tight, never delete it.
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await db.close();
    }
  });

  it('still rejects immediately, without waiting for the worker', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      const asked = performance.now();
      setTimeout(() => controller.abort(new Error('cancelled')), 50);
      await expect(long).rejects.toThrow('cancelled');
      expect(performance.now() - asked).toBeLessThan(200);
    } finally {
      await db.close();
    }
  });

  it('leaves nothing broken behind', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');
      // The same SQL runs again: the statement the abort left behind is
      // reusable, not poisoned, and it holds no read transaction open.
      expect(await db.read(longQuery(1_000))).toEqual([{ n: 1_000 }]);
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      });
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('leaves a sync build degraded, and says so by behaving so', async () => {
    // The ordinary test host is NOT cross-origin isolated, so this is the
    // degraded row of the design's §6: the signal stops the wait, not the work.
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');
      // A timeout DOES interrupt the same build — the asymmetry the design
      // turns on.
      await expect(
        db.read(longQuery(20_000_000), [], { timeout: 200 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch the first test fail**

```bash
pnpm exec rstest --project chromium run tests/browser/interrupt.test.ts
```

Expected: the short read takes ~1.9 s and the first test fails on the 500 ms bound. The
second and third already pass — they assert what is true today, and they must keep passing.

- [ ] **Step 3: Install the async shape**

`src/worker/worker.ts`, extending Task 1's installation block. The worker knows its build:
it is `options.build ?? defaultBuildFor(vfs)`, resolved in `open()` — keep it in a
module-scope `let currentBuild: SQLiteBuild` assigned there.

```ts
    // Three shapes, one handler. A `timeout` alone never needs to yield, and
    // yielding is the only cost this design has — so it is spent exactly where
    // nothing else can carry the signal into a running step().
    const wantsSignal = options?.abortable === true;
    const canYield = currentBuild !== 'sync';
    if (timeout !== undefined || (wantsSignal && canYield)) {
      const overBudget = () =>
        timeout !== undefined && spent + (performance.now() - stepStart) > timeout;
      sqlite.progress_handler(
        db,
        PROGRESS_OPS,
        wantsSignal && canYield
          ? async () => {
              // The task turn is what lets a queued `stop` be delivered.
              await gate.tick();
              return gate.isStopped() || overBudget() ? 1 : 0;
            }
          : () => (overBudget() ? 1 : 0),
        null,
      );
    }
```

`abortable` is a new boolean on the query message: the worker must not install a yielding
handler for every query, and it cannot see the caller's `AbortSignal`. Add
`abortable?: boolean` to `SQLOptions` in `src/types.ts` and `src/worker/worker.ts`, to
`PoolWorkerQueryOptions`, and set it in `src/queries.ts` where the signal is already known:

```ts
  const iterator = worker.query<T>(sql, params, {
    chunkSize,
    credits,
    timeout,
    abortable: signal !== undefined,
  });
```

- [ ] **Step 4: Run both engines**

```bash
pnpm exec rstest --project chromium run tests/browser/interrupt.test.ts
pnpm exec rstest --config rstest.firefox.config.ts run tests/browser/interrupt.test.ts
pnpm check && pnpm exec tsc --noEmit
```

Expected: three tests passing on each engine.

- [ ] **Step 5: Run the WHOLE suite before committing**

```bash
pnpm test
```

Expected: `status: pass`, `failedFiles: 0` on both projects. This task changes the timing of
every abort path in the library — `first()`, `stream()` early exit, the transaction unwind —
so the suite is the falsifier for the ones no new test covers.

- [ ] **Step 6: Commit**

```bash
git add src/worker/worker.ts src/types.ts src/pool.ts src/queries.ts tests/browser/interrupt.test.ts
git commit -m "feat(query): a signal now stops the statement, not just the wait"
```

---

### Task 3: the `cross-origin-isolated` capability

**Files:**
- Modify: `src/types.ts` — `PlatformFeature` (line 137) and a declaration beside
  `BUILD_REQUIREMENTS` (line 129)
- Modify: `src/capabilities.ts` — `PROBES` (line 15) and `FEATURE_LABEL`
- Test: `tests/unit/capabilities.test.ts` (existing — extend it)

**Interfaces:**
- Produces: the feature name `'cross-origin-isolated'`, its probe, and
  `BUILD_DEGRADES_WITHOUT: Record<SQLiteBuild, readonly PlatformFeature[]>` with
  `sync: ['cross-origin-isolated']` and `async: []`, `jspi: []`. Task 5 reads the probe.

- [ ] **Step 1: Write the failing test**

Extend the existing unit test file:

```ts
it('probes cross-origin isolation, and reports the host it runs in', () => {
  const features = detectFeatures();
  // Node and the test host are not isolated; the probe must say so rather
  // than throw or report the feature present.
  expect(features.includes('cross-origin-isolated')).toBe(
    globalThis.crossOriginIsolated === true,
  );
});

it('declares which build degrades without which feature', () => {
  expect(BUILD_DEGRADES_WITHOUT.sync).toEqual(['cross-origin-isolated']);
  expect(BUILD_DEGRADES_WITHOUT.async).toEqual([]);
  expect(BUILD_DEGRADES_WITHOUT.jspi).toEqual([]);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm exec rstest --project unit run tests/unit/capabilities.test.ts
```

- [ ] **Step 3: Implement**

`src/types.ts`:

```ts
export type PlatformFeature =
  | 'opfs'
  | 'readwrite-unsafe'
  | 'jspi'
  | 'writable-stream'
  | 'cross-origin-isolated';

/**
 * Platform features a build USES when present and works without, at a cost —
 * the symmetric of `degradesWithout` on a VFS, at the level where this one
 * actually lives. The `sync` build cannot carry an abort into a running
 * `step()` without a `SharedArrayBuffer`, and there is no SharedArrayBuffer
 * outside a cross-origin isolated context: measured 2026-09-04, it is not
 * restricted there, it is absent. Nothing here names COOP/COEP or
 * Document-Isolation-Policy: any of them satisfies the probe, and one of them
 * is Chrome-only.
 */
export const BUILD_DEGRADES_WITHOUT = {
  sync: ['cross-origin-isolated'],
  async: [],
  jspi: [],
} as const satisfies Record<SQLiteBuild, readonly PlatformFeature[]>;
```

`src/capabilities.ts` — one probe, and a label beside the others:

```ts
  'cross-origin-isolated': () => globalThis.crossOriginIsolated === true,
```

- [ ] **Step 4: Run the unit project and the type check**

```bash
pnpm exec rstest --project unit run tests/unit/capabilities.test.ts
pnpm check && pnpm exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/capabilities.ts tests/unit/capabilities.test.ts
git commit -m "feat(capabilities): declare the isolation the sync build degrades without"
```

---

### Task 4: an isolated test project

Gates Task 5. Nothing else depends on it, and if it cannot be made to work the fallback is
in Step 4 below — the design does not change either way.

**Files:**
- Create: `rstest.isolated.config.ts`
- Modify: `package.json` — a `test:isolated` script, and the `test` script chains it
- Modify: `.github/workflows/*` — wherever `pnpm test` runs, nothing changes; the chain does it
- Create: `tests/browser/isolated/environment.test.ts`

**Interfaces:**
- Produces: a project whose pages are cross-origin isolated, matching on
  `tests/browser/isolated/**/*.test.ts` — a directory the `chromium` and `firefox`
  projects do NOT pick up (their globs are non-recursive on purpose, see the comment in
  `rstest.config.ts`).

- [ ] **Step 1: Write the failing test**

`tests/browser/isolated/environment.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';

describe('the isolated project', () => {
  it('really is cross-origin isolated', () => {
    expect(globalThis.crossOriginIsolated).toBe(true);
    expect(typeof SharedArrayBuffer).toBe('function');
  });

  it('can hand a SharedArrayBuffer to a worker', async () => {
    const worker = new Worker(
      URL.createObjectURL(
        new Blob(
          [
            `self.onmessage = (e) => { const v = new Int32Array(e.data);
               Atomics.store(v, 0, 7); self.postMessage(Atomics.load(v, 0)); };`,
          ],
          { type: 'application/javascript' },
        ),
      ),
    );
    const seen = await new Promise((resolve) => {
      worker.onmessage = (e) => resolve(e.data);
      worker.postMessage(new SharedArrayBuffer(8));
    });
    worker.terminate();
    expect(seen).toBe(7);
  });
});
```

- [ ] **Step 2: Run it against the ordinary project and watch it fail**

```bash
pnpm exec rstest --project chromium run tests/browser/isolated/environment.test.ts
```

Expected: `crossOriginIsolated` is `false`. (It also proves the file is reachable only when
pointed at explicitly — the `chromium` project's glob does not include the subdirectory.)

- [ ] **Step 3: Write the config**

`rstest.isolated.config.ts` — copy `rstest.firefox.config.ts`'s shape, keep Chromium, and
add the two headers:

```ts
import { defineConfig } from '@rstest/core';
import { pluginSilenceWorkerHmrLogs } from './rstest.config';

/**
 * The ONE project whose pages are cross-origin isolated, which is what makes
 * `SharedArrayBuffer` exist at all. It carries the sync build's abort channel
 * and nothing else: the ordinary projects deliberately stay un-isolated,
 * because that is the configuration most consumers deploy and the degraded row
 * of the design has to be asserted somewhere.
 */
export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  name: 'isolated',
  browser: {
    enabled: true,
    provider: 'playwright',
    browser: 'chromium',
    headless: true,
  },
  plugins: [pluginSilenceWorkerHmrLogs],
  include: ['tests/browser/isolated/**/*.test.ts'],
  testTimeout: 30000,
});
```

- [ ] **Step 4: Run it — and decide here if it does not work**

```bash
pnpm exec rstest --config rstest.isolated.config.ts run
```

Expected: both tests pass. **If `server.headers` does not reach the rsbuild dev server from
an rstest config**, do not fight it: delete `rstest.isolated.config.ts` and
`tests/browser/isolated/`, record the finding in the plan's task list and in
`mem:follow-ups`, and carry Task 5's verification with a hand-run probe under
`.scratchpad/interrupt-1/` instead, modelled on `dip.mjs` which already isolates a page with
one header and drives both engines. Task 5's code does not change.

- [ ] **Step 5: Chain it into `pnpm test`**

`package.json`:

```json
"test": "rstest && rstest --config rstest.firefox.config.ts && rstest --config rstest.isolated.config.ts",
"test:isolated": "rstest --config rstest.isolated.config.ts",
```

- [ ] **Step 6: Run the whole suite and commit**

```bash
pnpm test && pnpm check && pnpm exec tsc --noEmit
git add rstest.isolated.config.ts package.json tests/browser/isolated/environment.test.ts
git commit -m "test(isolated): a project that is cross-origin isolated, for the one path that needs it"
```

---

### Task 5: the shared abort slot, for the `sync` build under isolation

**Files:**
- Modify: `src/client.ts` — allocate one buffer per client, pass it to `createPoolWorker`
- Modify: `src/pool.ts` — the `deps`, the zeroing on spawn, the `open` message, `interrupt()`
- Modify: `src/types.ts` — the `open` message's two new fields
- Modify: `src/worker/worker.ts` — the third handler shape
- Test: `tests/browser/isolated/abort-slot.test.ts` (new)

**Interfaces:**
- Consumes: the probe from Task 3, the handler installation from Tasks 1-2, the isolated
  project from Task 4.
- Produces: `abortSlots?: SharedArrayBuffer` and `abortIndex?: number` on the `open` message.

- [ ] **Step 1: Write the failing test**

`tests/browser/isolated/abort-slot.test.ts` — the same assertion as Task 2's first test, on
the build that could not do it. `interceptWorkers` + `dispatchEvent(new ErrorEvent('error'))`
is how this repository kills a worker (`tests/browser/lifecycle.test.ts:38`); do not invent
another way.

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, longQuery } from '../helpers';

describe('the sync build, isolated', () => {
  it('stops a running statement on abort', async () => {
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');

      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await db.close();
    }
  });

  it("does not carry a dead worker's abort into its replacement", async () => {
    // The slot holds a callId, and a restarted worker's callIds start at 0
    // again — so the slot must be zeroed when a worker is created into it.
    // Without that zeroing this test fails on the query whose callId matches
    // the one the abort wrote, and on no other: the defect is a single wrong
    // interrupt, several queries after the restart.
    const records = interceptWorkers();
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
      maxWorkerRestarts: 1,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');
      const abortedCallId = records[0]?.posted.filter((t) => t === 'query')
        .length;
      expect(abortedCallId).toBeGreaterThan(0);

      // Kill the worker the abort was written for, then run past the callId
      // the slot still holds on its replacement.
      records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
      for (let i = 0; i < 8; i++) {
        expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      }
    } finally {
      await db.close();
    }
  });
});
```

- [ ] **Step 2: Run it and watch the first test fail**

```bash
pnpm exec rstest --config rstest.isolated.config.ts run
```

Expected: the short read takes ~1.9 s.

- [ ] **Step 3: Allocate the buffer in the client**

`src/client.ts`, where the pool is created — one buffer for the whole client, only when the
platform has one:

```ts
  /**
   * One Int32 per worker, holding the callId to abort. Allocated only in a
   * cross-origin isolated context, because `SharedArrayBuffer` does not exist
   * anywhere else — measured 2026-09-04 on both engines: absent, not
   * restricted. Everywhere else this stays undefined and the whole channel is
   * a branch not taken.
   */
  const abortSlots =
    typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated
      ? new SharedArrayBuffer(4 * poolSize)
      : undefined;
```

Pass it into `createPoolWorker`'s `deps` beside `index`.

- [ ] **Step 4: Wire the pool**

`src/pool.ts` — `deps` gains `abortSlots?: SharedArrayBuffer | undefined`. Right after the
worker is spawned and before the `open` message:

```ts
  // A restarted worker inherits this slot, and its callIds restart at 0 — so
  // the predecessor's last abort would fire on the replacement's seventh call.
  // Zeroing here is the whole guard, and it belongs where the worker is born.
  if (abortSlots) new Int32Array(abortSlots)[index] = 0;
```

The `open` message carries both:

```ts
    abortSlots,
    abortIndex: abortSlots ? index : undefined,
```

And `interrupt()` writes the callId beside the message it already posts:

```ts
    // Two channels, disjoint: the message wakes a worker parked on a credit,
    // the slot reaches one that is computing inside step() and reads no
    // messages until it yields — which the sync build never does.
    if (abortSlots) Atomics.store(new Int32Array(abortSlots), index, currentCallId);
    worker.postMessage({ type: 'stop', callId: currentCallId });
```

- [ ] **Step 5: Read the slot in the worker**

`src/types.ts` — the `open` message gains:

```ts
      /** Shared abort slots, one Int32 per worker. Isolated contexts only. */
      abortSlots?: SharedArrayBuffer;
      /** This worker's index into `abortSlots`. */
      abortIndex?: number;
```

`src/worker/worker.ts` — keep them at module scope in `open()`, and add the third shape to
the installation block from Task 2:

```ts
    const slot =
      abortSlots && abortIndex !== undefined
        ? new Int32Array(abortSlots)
        : undefined;
    const abortedHere = () =>
      slot !== undefined && Atomics.load(slot, abortIndex as number) === callId;
```

The `sync` branch of the handler becomes:

```ts
          : () => (abortedHere() || overBudget() ? 1 : 0),
```

and the install condition widens: `timeout !== undefined || (wantsSignal && (canYield ||
slot !== undefined))`. `callId` is already in scope in the `query` message handler; thread it
into `query()` as an argument rather than reaching for a module-scope copy.

- [ ] **Step 6: Run the isolated project, then everything**

```bash
pnpm exec rstest --config rstest.isolated.config.ts run
pnpm test && pnpm check && pnpm exec tsc --noEmit
```

Expected: the isolated tests pass, and the un-isolated projects are unchanged — in
particular Task 2's third test still asserts the degraded behaviour, because those projects
have no `SharedArrayBuffer` and the client allocates nothing.

- [ ] **Step 7: Commit**

```bash
git add src/client.ts src/pool.ts src/types.ts src/worker/worker.ts tests/browser/isolated/abort-slot.test.ts
git commit -m "feat(query): carry an abort into a running sync step, where the platform allows it"
```

---

### Task 6: the documentation the design promised

**Files:**
- Modify: `README.md` — a new `## Interrupting a query` section after `## Options`
- Modify: `src/api.ts` — the pointer in `OptionsWithSignal`'s TSDoc
- Modify: `CHANGELOG.md` — the Unreleased section

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the README section**

After `## Options`, and **in the register the repository uses for the README — the
constraint and what it costs the reader, not the mechanism** (`mem:conventions`):

```markdown
## Interrupting a query

`signal` always stops the *wait*: your promise rejects with `signal.reason` straight away,
as `fetch()` does. Whether it also stops the *work* — the statement SQLite is executing —
depends on the build behind your VFS:

| build | your VFS | a `signal` stops a running statement |
|---|---|---|
| `async`, `jspi` | `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `MemoryAsyncVFS` | yes |
| `sync` | `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS` | only if your page is cross-origin isolated |

Where it does not, an aborted query keeps running to its end on its worker; the pool's other
workers are unaffected. Two ways out, and you may want neither: serve your page cross-origin
isolated (any of COOP+COEP or `Document-Isolation-Policy` does it), or pass
`build: 'async'`, which every one of those four VFS accepts.

`timeout` needs none of that. It works on every build, and it counts SQLite execution time —
time your own code spends between two chunks of a `stream()` is not charged to it. For a
wall-clock deadline instead, pass `AbortSignal.timeout(ms)` as `signal`.
```

- [ ] **Step 2: Point the TSDoc at it**

`src/api.ts`, in `OptionsWithSignal`'s `signal` comment, one sentence appended:

```
   * Whether it also stops the statement SQLite is already executing depends on
   * your build and your page: see the README's Interrupting a query section.
```

- [ ] **Step 3: Write the CHANGELOG entries**

Under `## Unreleased`, in the existing subsections, written for a consumer:

```markdown
### Added

- **`timeout`, a per-query budget in milliseconds.** A query that spends more than it is
  stopped and rejected with the new `QUERY_TIMEOUT` code. It counts **SQLite execution
  time**, not elapsed time: the seconds your own code spends between two chunks of a
  `stream()` are not charged to it, so a slow consumer never kills its own query. For a
  wall-clock deadline instead, pass `AbortSignal.timeout(ms)` as `signal` — it always
  worked and still does. Available on the query methods only: a budget for a whole
  `transaction()`, `bulkWrite()` or `output()` would be a different feature.
- **`QUERY_TIMEOUT`, a new error code.** Deliberately distinct from `TIMEOUT`, which means a
  deadline this library imposed on itself — a worker that never became ready, a deletion
  that did not complete. The new one means the budget you set is spent.

### Changed

- **An aborted query now stops the statement, not only the wait.** `signal` behaves exactly
  as before from the caller's side — the promise still rejects with `signal.reason`
  immediately, as `fetch()` does — but the worker no longer runs the abandoned statement to
  its end. Measured: a short query issued right after an abort on the same worker waited
  **1 889 ms** and now returns in milliseconds. This holds on the `async` and `jspi` builds
  everywhere, and on the `sync` build when your page is cross-origin isolated. Where neither
  holds, behaviour is unchanged; the README's new *Interrupting a query* section says which
  case you are in and what it costs to change it.
```
- [ ] **Step 4: Verify the README's generated parts did not move**

```bash
pnpm check && pnpm exec tsc --noEmit && pnpm test
git diff --stat
```

The VFS table is generated; if it changed, something touched `VFS_CAPABILITIES` and that is
a defect in this task, not a README edit to accept.

- [ ] **Step 5: Commit**

```bash
git add README.md src/api.ts CHANGELOG.md
git commit -m "docs(query): what a signal stops, and what it does not"
```

---

## Verification before the branch is offered for merge

Against the baseline table in `mem:state` — re-read every row, do not patch one cell:

```bash
pnpm exec tsc --noEmit
pnpm build
pnpm test                 # chromium + firefox + isolated
pnpm test:conformance     # both engines, 73 passed / 12 skipped each
pnpm test:consumer        # 24/24
pnpm lint
node scripts/bench/check.mjs chromium --all
```

The bench page is not expected to change: no `src/` API it uses moved, and interruptibility
is not a VFS property. `check.mjs` runs because the page imports `dist/index.js`, and this
branch changes what that file exports.
