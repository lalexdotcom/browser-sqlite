# Wave 1 — Pool, Scheduler and a Single Abort — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `client.ts` into focused modules, make worker exclusivity real by construction, and implement query cancellation exactly once.

**Architecture:** A pure `scheduler.ts` owns worker availability and hands out opaque leases; `PoolWorker.available` is deleted so no other module can republish a worker. `pool.ts` owns worker creation and the `postMessage` transport, including the stop-and-drain routine that runs when a query generator closes early. `queries.ts` layers `chunk()` over that transport and is the single place abort is implemented. `transaction.ts` holds one lease for its whole lifetime; `bulk.ts` is a verbatim move.

**Tech Stack:** TypeScript 7.0.2 (ESM only), rslib 0.23.2, rstest 0.11.8 (`unit` project = Node, `browser` project = Chromium via Playwright), biome 2.5.8, pnpm 10.31.0.

**Spec:** `docs/superpowers/specs/2026-08-18-wave-1-pool-scheduler-design.md`

## Global Constraints

- **Language:** French in chat only. All code, comments, commit messages, docs: English.
- **Serena first.** Symbolic tools (`find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `rename`, `move`) are PRIMARY for `.ts` files. Built-in Read/Edit/Grep on code only when Serena fails or the file is unparseable. `client.ts` is a single 736-line factory closure the LSP cannot see inside — built-in tools are the accepted fallback **for that file only**.
- **After every modification:** `pnpm check` (biome, writes fixes).
- **Verification at every task, always wrapped in a hard timeout:**

  ```bash
  timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test
  ```

  All three must pass before committing. **Never run an unbounded test command.** A per-test `testTimeout` only catches a slow test; it does not catch a suite that finishes and never exits because a Web Worker handle stayed open — which is the failure mode this wave actively risks (Task 4's drain loop waits for a `done` that a dead worker never sends). A `timeout` exit code 124 is a hard failure to report, not a result to wait out.
- **Per-test bounds** are set in `rstest.config.ts`: 30 s in the `browser` project (worker boot plus OPFS), 10 s in `unit` (pure Node — anything near it is a deadlock, not slowness).
- **Test count baseline:** 105 tests green at the start (57 unit + 48 browser).
- **`it.fails` convention:** a pinned test asserts the *correct* behaviour; `.fails` asserts the bug is still present. When the bug is fixed the test starts passing, which makes `it.fails` **fail** — that red is the signal to drop `.fails`, not a regression. Never re-add it.
- **No `CHANGELOG.md`.** `1.0.0-rc.3` has no consumer; breaking changes are recorded in `.serena/memories/`, not in a migration note.
- **Behaviour preserved deliberately:** scheduling policy stays lowest-index-first with a sticky writer. `bulk-write.test.ts` and `output.test.ts` must pass **unmodified** — they are the control specimen for the code movement.
- **Out of scope, do not "fix while in there":** B2 (worker `onerror`, timeouts), B3 (`close()` handshake), B4 (identifier quoting), B5 (bulk failures), B6 (debug wiring), BP-1 (back-pressure), D2 (SAB removal).
- **Branch:** all work on `wave-1-pool-scheduler`, never on `main`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/scheduler.ts` | Create | Pure. Availability set, both wait queues, writer designation, leases. No `Worker`, no DOM, no orchestrator import. |
| `src/pool.ts` | Create | Worker creation, `postMessage`/`onmessage` transport keyed by `callId`, the raw query generator and its stop-and-drain `finally`. |
| `src/queries.ts` | Create | `chunk()` and its derivations. The only place `AbortSignal` is read. |
| `src/transaction.ts` | Create | `transaction()` over a single held lease. |
| `src/bulk.ts` | Create | `bulkWrite()` + `output()`, moved verbatim. |
| `src/client.ts` | Modify | Assembly only: options, validation, wiring, public `SQLiteDB` surface, `close()`. |
| `src/utils.ts` | Modify | `isWriteQuery` replaced by a read allowlist (Task 8). |
| `tests/unit/scheduler.test.ts` | Create | Node tests for the scheduler. |
| `tests/browser/concurrency.test.ts` | Modify | Drop B9's `.fails`, rewrite `INT-09`, add listener and reuse tests. |
| `tests/browser/transaction.test.ts` | Modify | Drop B1's `.fails`. |
| `tests/browser/routing.test.ts` | Create | Task 8's routing assertions. |

---

## Task 1: The pure scheduler

**Files:**
- Create: `src/scheduler.ts`
- Test: `tests/unit/scheduler.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Lease<W> = { readonly worker: W; release: () => void }`
  - `type Scheduler<W> = { add: (worker: W) => void; acquire: (kind: 'read' | 'write') => Promise<Lease<W>> }`
  - `createScheduler<W extends { index: number }>(opts?: { onIdle?: (worker: W) => void }): Scheduler<W>`

Nothing imports this module yet. The library's behaviour is unchanged by this task; the suite must stay at 105 green.

- [ ] **Step 1: Create the branch**

```bash
git checkout -b wave-1-pool-scheduler
git status --short   # expect empty
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/scheduler.test.ts`. `TestWorker` is the minimal shape the scheduler is parameterised over — this is the whole point of the module being pure.

```ts
import { describe, expect, it } from '@rstest/core';
import { createScheduler } from '../../src/scheduler';

type TestWorker = { index: number };

const makeScheduler = (size = 2, onIdle?: (w: TestWorker) => void) => {
  const scheduler = createScheduler<TestWorker>(onIdle ? { onIdle } : {});
  const workers = Array.from({ length: size }, (_, index) => ({ index }));
  for (const worker of workers) scheduler.add(worker);
  return { scheduler, workers };
};

describe('scheduler — acquisition', () => {
  it('hands out the lowest-index available worker', async () => {
    const { scheduler } = makeScheduler(3);
    const a = await scheduler.acquire('read');
    const b = await scheduler.acquire('read');
    expect(a.worker.index).toBe(0);
    expect(b.worker.index).toBe(1);
  });

  it('does not hand the same worker to two holders', async () => {
    const { scheduler } = makeScheduler(1);
    const first = await scheduler.acquire('read');
    let secondIndex: number | undefined;
    void scheduler.acquire('read').then((lease) => {
      secondIndex = lease.worker.index;
    });
    await Promise.resolve();
    expect(secondIndex).toBeUndefined();
    first.release();
    await Promise.resolve();
    expect(secondIndex).toBe(0);
  });

  it('serves queued requests in FIFO order', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const order: string[] = [];
    const one = scheduler.acquire('read').then(() => order.push('one'));
    const two = scheduler.acquire('read').then((l) => {
      order.push('two');
      l.release();
    });
    held.release();
    await one;
    await two;
    expect(order).toEqual(['one', 'two']);
  });

  it('serves a waiting writer before a waiting reader', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('write');
    const order: string[] = [];
    const reader = scheduler.acquire('read').then((l) => {
      order.push('read');
      l.release();
    });
    const writer = scheduler.acquire('write').then((l) => {
      order.push('write');
      l.release();
    });
    held.release();
    await writer;
    await reader;
    expect(order).toEqual(['write', 'read']);
  });
});

describe('scheduler — writer designation', () => {
  it('routes every write to the same worker once one is designated', async () => {
    const { scheduler } = makeScheduler(3);
    const a = await scheduler.acquire('write');
    a.release();
    const b = await scheduler.acquire('write');
    expect(b.worker.index).toBe(a.worker.index);
  });

  it('designates the writer when a queued writer is served', async () => {
    // Regression: the original releaseWorker handed the worker to a queued
    // writer without setting currentWriterIndex when it was -1, so the next
    // write acquisition could designate a SECOND writer.
    //
    // Both workers must be busy for the write to actually queue, and worker 1
    // must be the one released — otherwise the buggy path (designation left at
    // -1, lowest-index-first) and the correct path both pick worker 0 and the
    // test proves nothing.
    const { scheduler } = makeScheduler(2);
    const readerA = await scheduler.acquire('read'); // worker 0
    const readerB = await scheduler.acquire('read'); // worker 1
    const queued = scheduler.acquire('write');

    readerB.release();
    const served = await queued;
    expect(served.worker.index).toBe(1);

    readerA.release();
    served.release();

    const next = await scheduler.acquire('write');
    // Correct: designation is 1, so the write goes back to worker 1.
    // Buggy: designation is still -1, so lowest-index-first picks worker 0.
    expect(next.worker.index).toBe(1);
  });

  it('clears the designation when the writer goes to a reader', async () => {
    // A reader must genuinely queue, so every worker has to be busy first.
    const { scheduler } = makeScheduler(2);
    const writer = await scheduler.acquire('write'); // worker 0, designated
    const reader = await scheduler.acquire('read'); // worker 1
    const queuedReader = scheduler.acquire('read');

    writer.release(); // hands worker 0 to the queued reader, clearing designation
    const servedReader = await queuedReader;
    expect(servedReader.worker.index).toBe(0);

    // With the designation cleared, a queued write claims whichever worker frees
    // up next — here worker 1, not the former writer.
    const queuedWrite = scheduler.acquire('write');
    reader.release();
    const newWriter = await queuedWrite;
    expect(newWriter.worker.index).toBe(1);
  });
});

describe('scheduler — leases', () => {
  it('keeps a worker across many statements while others wait (B1)', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('write');
    let intruder: number | undefined;
    void scheduler.acquire('read').then((l) => {
      intruder = l.worker.index;
    });
    for (let statement = 0; statement < 5; statement++) {
      await Promise.resolve();
      expect(intruder).toBeUndefined();
    }
    held.release();
    await Promise.resolve();
    expect(intruder).toBe(0);
  });

  it('ignores a second release', async () => {
    const { scheduler } = makeScheduler(1);
    const lease = await scheduler.acquire('read');
    lease.release();
    lease.release();
    const next = await scheduler.acquire('read');
    expect(next.worker.index).toBe(0);
    let extra: number | undefined;
    void scheduler.acquire('read').then((l) => {
      extra = l.worker.index;
    });
    await Promise.resolve();
    expect(extra).toBeUndefined();
  });

  it('calls onIdle only when no request is waiting', async () => {
    const idle: number[] = [];
    const { scheduler } = makeScheduler(1, (w) => idle.push(w.index));
    const held = await scheduler.acquire('read');
    const queued = scheduler.acquire('read');
    held.release();
    const served = await queued;
    expect(idle).toEqual([]);
    served.release();
    expect(idle).toEqual([0]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test:unit`
Expected: FAIL — `Cannot find module '../../src/scheduler'`.

- [ ] **Step 4: Write the implementation**

Create `src/scheduler.ts`:

```ts
/**
 * Pure worker scheduling: availability, wait queues, writer designation.
 *
 * This module is deliberately free of `Worker`, DOM and orchestrator imports so
 * it can be exercised by fast Node tests. B1 survived for months because the
 * scheduler was only reachable through slow browser tests.
 */

/**
 * A borrowed worker. `release()` is the only way back into the pool and is
 * idempotent — a second call is a no-op, not an error.
 */
export type Lease<W> = {
  readonly worker: W;
  release: () => void;
};

export type Scheduler<W> = {
  add: (worker: W) => void;
  acquire: (kind: 'read' | 'write') => Promise<Lease<W>>;
};

/**
 * Creates a scheduler over workers identified by a numeric `index`.
 *
 * @param opts.onIdle - Called when a released worker returns to the available
 *   set with nothing queued behind it. The client wires the orchestrator's
 *   `READY` status here; the scheduler itself knows nothing about shared memory.
 */
export const createScheduler = <W extends { index: number }>(
  opts: { onIdle?: (worker: W) => void } = {},
): Scheduler<W> => {
  const workers: W[] = [];

  // Availability lives HERE and nowhere else. No worker carries an `available`
  // flag, so no other module can republish a borrowed worker — which is exactly
  // how B1 happened.
  const available = new Set<number>();

  const readerQueue: Array<(worker: W) => void> = [];
  const writerQueue: Array<(worker: W) => void> = [];

  // Index of the worker designated for writes, or -1 when none is designated.
  let currentWriterIndex = -1;

  const handOver = (worker: W) => {
    // Writers first, but only onto the designated writer (or when no writer is
    // designated yet).
    if (
      writerQueue.length &&
      (currentWriterIndex === worker.index || currentWriterIndex === -1)
    ) {
      // Claim the designation before serving. The original code omitted this,
      // so a later write acquisition could designate a second writer while this
      // one was still running.
      currentWriterIndex = worker.index;
      writerQueue.shift()?.(worker);
      return;
    }

    if (readerQueue.length) {
      if (currentWriterIndex === worker.index) currentWriterIndex = -1;
      readerQueue.shift()?.(worker);
      return;
    }

    available.add(worker.index);
    opts.onIdle?.(worker);
  };

  const makeLease = (worker: W): Lease<W> => {
    let released = false;
    return {
      worker,
      release: () => {
        if (released) return;
        released = true;
        handOver(worker);
      },
    };
  };

  const takeAvailable = (write: boolean): W | undefined => {
    if (write && currentWriterIndex > -1) {
      if (!available.has(currentWriterIndex)) return undefined;
      available.delete(currentWriterIndex);
      return workers[currentWriterIndex];
    }

    // Lowest-index-first, preserved from the original implementation.
    const found = workers.find((worker) => available.has(worker.index));
    if (!found) return undefined;

    available.delete(found.index);
    if (write) currentWriterIndex = found.index;
    return found;
  };

  return {
    add: (worker) => {
      workers[worker.index] = worker;
      available.add(worker.index);
    },

    acquire: async (kind) => {
      const write = kind === 'write';

      const immediate = takeAvailable(write);
      if (immediate) return makeLease(immediate);

      const { promise, resolve } = Promise.withResolvers<W>();
      (write ? writerQueue : readerQueue).push(resolve);
      return makeLease(await promise);
    },
  };
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test:unit`
Expected: PASS — 57 pre-existing unit tests plus 10 new ones.

- [ ] **Step 6: Verify nothing else moved**

```bash
pnpm check && npx tsc --noEmit && pnpm test
```
Expected: 115 tests, all green. Both `it.fails` (B1, B9) still failing as expected — nothing is wired yet.

- [ ] **Step 7: Commit**

```bash
git add src/scheduler.ts tests/unit/scheduler.test.ts
git commit -m "feat(scheduler): pure lease-based scheduler, unit-tested in Node

Availability, both wait queues and the writer designation move into a
module with no Worker, DOM or orchestrator import, so a Node test can
drive them in milliseconds. Not wired yet.

Fixes a latent defect while specifying the behaviour: serving a queued
writer did not claim the designation when none was set, so a later write
could designate a second writer."
```

---

## Task 2: Extract `pool.ts` and wire the leases

**Files:**
- Create: `src/pool.ts`
- Modify: `src/client.ts` (worker creation removed; all acquire/release call sites converted)
- Modify: `tests/browser/transaction.test.ts` (drop B1's `.fails`)

**Interfaces:**
- Consumes: `createScheduler`, `Lease`, `Scheduler` from Task 1.
- Produces:
  - `type PoolWorker = Worker & { index: number; query: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: { chunkSize?: number }) => AsyncGenerator<T[] | number> }` — note **no `available` field**.
  - `createPoolWorker(deps: { orchestrator: WorkerOrchestrator; pool: PoolWorker[]; clientPrefix: string; file: string; vfs: SQLiteVFS; pragmas?: Record<string, string> }): Promise<PoolWorker>`

This is the crux task: it is where exclusivity actually changes, and therefore where B1 is fixed.

- [ ] **Step 1: Confirm B1 is still pinned**

Run: `pnpm test:browser`
Expected: PASS overall, with the B1 test in `tests/browser/transaction.test.ts` reported as an expected failure (`it.fails`). Note its name; you will drop `.fails` in Step 6.

- [ ] **Step 2: Create `src/pool.ts`**

Move `createWorker` (`src/client.ts:322-470`) verbatim into `createPoolWorker`, with three changes and no others:

1. Closure variables become explicit `deps` parameters.
2. **Delete both `available` assignments.** `Object.assign(pool[index], { index, available: false })` becomes `Object.assign(pool[index], { index })`, and the `worker.available = true` in the `ready` branch of `onmessage` is removed.
3. **Delete `worker.available = false` and `worker.available = true` from the `query` generator** (`client.ts:411` and `client.ts:454`). The generator no longer touches scheduling state at all — that is the whole point.

Keep for now, unchanged: the `deferredChunk` protocol, the `signalAbortHandler` and its `signal` option, the debug hooks, the `postMessage({ type: 'open', ... })` call. Abort is reworked in Task 4, not here.

- [ ] **Step 3: Wire the scheduler into `client.ts`**

Replace `acquireWorker`, `acquireNextWorker`, `getNextAvailableWorker`, `releaseWorker`, both queues and `currentWriterIndex` (`src/client.ts:473-578`) with:

```ts
const scheduler = createScheduler<PoolWorker>({
  onIdle: (worker) =>
    orchestrator.setStatus(worker.index, WorkerStatuses.READY),
});
```

Convert every call site from the acquire/release pair to a lease. The six-line shape is unchanged; only the ownership is:

```ts
const read = async <T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
  options?: SQLiteQueryOptions<T>,
) => {
  const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
  try {
    return await readWorker(lease.worker, sql, params, options);
  } finally {
    lease.release();
  }
};
```

Apply the identical shape to `write`, `stream`, `one` and `transaction`. **`transaction()` takes its lease once, before `db.read('BEGIN')`, and releases it in its existing `finally`** — it already had that structure; it simply now means something.

Pool initialisation (`src/client.ts:990-1000`) becomes:

```ts
Promise.all(
  Array.from({ length: poolSize }).map(() =>
    createPoolWorker({ orchestrator, pool, clientPrefix, file, vfs, pragmas: clientOptions?.pragmas }),
  ),
).then((allWorkers) => {
  for (const worker of allWorkers) scheduler.add(worker);
});
```

- [ ] **Step 4: Run the browser suite**

Run: `pnpm test:browser`
Expected: the B1 test now **passes**, which makes `it.fails` report a failure: "Expected test to fail, but it passed". That red is the success signal.

- [ ] **Step 5: Run the whole suite**

Run: `pnpm check && npx tsc --noEmit && pnpm test`
Expected: everything green except the B1 `it.fails` inversion from Step 4.

- [ ] **Step 6: Drop `.fails` on the B1 test**

In `tests/browser/transaction.test.ts`, change `it.fails(` to `it(` on the B1 test only. Leave B9's pin in `concurrency.test.ts` untouched — it is Task 4's.

- [ ] **Step 7: Verify**

Run: `pnpm check && npx tsc --noEmit && pnpm test`
Expected: 115 green. Only B9 remains pinned.

- [ ] **Step 8: Commit**

```bash
git add src/pool.ts src/client.ts tests/browser/transaction.test.ts
git commit -m "fix(pool): exclusivity by lease — B1

PoolWorker.available is deleted outright, not guarded. Availability lives
in the scheduler, so the per-statement finally that republished a worker
mid-transaction cannot be written any more.

transaction() now holds one lease for its whole lifetime, so a concurrent
read can no longer execute inside an open transaction. Drops B1's .fails."
```

---

## Task 3: Extract `queries.ts` verbatim

**Files:**
- Create: `src/queries.ts`
- Modify: `src/client.ts`

**Interfaces:**
- Consumes: `PoolWorker` (Task 2), `Lease` (Task 1).
- Produces (worker-bound helpers, unchanged semantics): `readWorker`, `writeWorker`, `streamWorker`, `oneWorker` — same signatures as today, each taking a `PoolWorker` as first argument.

Pure movement. No behaviour change, no test change. This task exists so that Task 4's diff contains only semantics.

- [ ] **Step 1: Move the four helpers**

Move `readWorker` (`client.ts:583-597`), `streamWorker` (`client.ts:619-633`), `writeWorker` (`client.ts:653-673`) and `oneWorker` (`client.ts:694-716`) into `src/queries.ts`, exported, bodies **byte-identical** apart from imports.

- [ ] **Step 2: Import them in `client.ts`**

```ts
import { oneWorker, readWorker, streamWorker, writeWorker } from './queries';
```

The five public methods stay in `client.ts` for now.

- [ ] **Step 3: Verify the move changed nothing**

```bash
pnpm check && npx tsc --noEmit && pnpm test
```
Expected: 115 green, B9 still pinned. If any test changes state, the move was not pure — revert and redo.

- [ ] **Step 4: Commit**

```bash
git add src/queries.ts src/client.ts
git commit -m "refactor(queries): move the worker-bound query helpers out of client.ts

Pure move, bodies unchanged. Isolated so the abort rework that follows
contains semantics only."
```

---

## Task 4: `chunk()` and a single abort

**Files:**
- Modify: `src/pool.ts` (stop-and-drain in the raw generator's `finally`)
- Modify: `src/queries.ts` (the `chunk()` primitive and its derivations)
- Modify: `src/client.ts` (public methods delegate to the new derivations)
- Modify: `tests/browser/concurrency.test.ts`

**Interfaces:**
- Consumes: `PoolWorker.query` (Task 2), the helpers from Task 3.
- Produces:
  - `chunk<T>(worker, sql, params?, options?: { chunkSize?: number; signal?: AbortSignal }): AsyncGenerator<T[]>`
  - `streamRows<T>(...): AsyncGenerator<T>` — flattens
  - `readWorker<T>(...): Promise<T[]>` — drains
  - `firstWorker<T>(...): Promise<T | undefined>` — first row, then breaks
  - `writeWorker<T>(...): Promise<{ result: T[]; affected: number }>`

- [ ] **Step 1: Write the failing tests**

In `tests/browser/concurrency.test.ts`, replace the whole `describe('AbortSignal (INT-09)')` block with:

```ts
describe('AbortSignal (INT-09)', () => {
  const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
    await db.write('CREATE TABLE bigdata (n INTEGER)');
    const values = Array.from({ length: 1000 }, (_, i) => `(${i + 1})`).join(',');
    await db.write(`INSERT INTO bigdata VALUES ${values}`);
  };

  it('rejects with AbortError and delivers nothing after the abort', async () => {
    const db = await createTestClient();
    await seed(db);

    const controller = new AbortController();
    let chunkCount = 0;

    const gen = db.chunk<{ n: number }>('SELECT n FROM bigdata ORDER BY n', [], {
      signal: controller.signal,
      chunkSize: 50,
    });

    const first = await gen.next();
    expect(first.done).toBe(false);
    chunkCount++;
    controller.abort();

    // Deterministic: chunk() stops yielding on abort regardless of how many
    // chunks the worker already pushed into the message queue. An inexact
    // bound here would be unfalsifiable, which is the defect wave 0 removed.
    await expect(gen.next()).rejects.toThrow(/abort/i);
    expect(chunkCount).toBe(1);

    db.close();
  });

  it('rejects immediately when the signal is already aborted (B9)', async () => {
    const db = await createTestClient();
    await seed(db);

    const controller = new AbortController();
    controller.abort();

    let delivered = 0;
    await expect(async () => {
      for await (const _rows of db.chunk('SELECT n FROM bigdata', [], {
        signal: controller.signal,
      })) {
        delivered++;
      }
    }).rejects.toThrow(/abort/i);
    expect(delivered).toBe(0);

    db.close();
  });

  it('removes its abort listener when the query ends early', async () => {
    const db = await createTestClient();
    await seed(db);

    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const signal = new Proxy(controller.signal, {
      get(target, prop, receiver) {
        if (prop === 'addEventListener') {
          return (...args: Parameters<AbortSignal['addEventListener']>) => {
            added++;
            return target.addEventListener(...args);
          };
        }
        if (prop === 'removeEventListener') {
          return (...args: Parameters<AbortSignal['removeEventListener']>) => {
            removed++;
            return target.removeEventListener(...args);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await db.first('SELECT n FROM bigdata ORDER BY n', [], { signal });
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);

    db.close();
  });

  it('leaves the worker immediately reusable after first()', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await seed(db);

    const row = await db.first<{ n: number }>('SELECT n FROM bigdata ORDER BY n');
    expect(row?.n).toBe(1);

    // With poolSize 1 this can only succeed if the aborted query was fully
    // settled — i.e. the in-flight `done` was awaited before the lease returned.
    const all = await db.read<{ n: number }>('SELECT n FROM bigdata ORDER BY n');
    expect(all).toHaveLength(1000);

    db.close();
  });
});
```

**Delete** the existing `it.fails('an already-aborted AbortSignal…')` test — the second new test above supersedes it and asserts strictly more (it also checks that nothing was delivered). After this task, `grep -rn "it.fails" tests/` must return nothing.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test:browser`
Expected: FAIL — `db.chunk is not a function`, `db.first is not a function`, and the abort tests hanging or delivering all chunks.

- [ ] **Step 3: Add stop-and-drain to the raw generator in `pool.ts`**

Replace the `query` generator's `finally` block. The generator no longer takes a `signal` at all — cancellation policy moves up to `queries.ts`.

```ts
} finally {
  // If the consumer left early (break / return / throw) the worker is still
  // stepping rows. Tell it to stop, then wait for the reply it always sends,
  // so the worker is genuinely idle before the lease goes back to the pool.
  // Without this wait, the second half of B1 stands: a released worker still
  // inside sqlite.step().
  if (deferredChunk) {
    orchestrator.setStatus(index, WorkerStatuses.ABORTING, WorkerStatuses.RUNNING);
    try {
      // The message handler replaces deferredChunk on every 'chunk' and clears
      // it on 'done' / 'error', so this drains to completion.
      while (deferredChunk) await deferredChunk.promise;
    } catch {
      // The worker reported an error while winding down. The caller is already
      // unwinding; surfacing it here would mask their reason.
    }
  }
  deferredChunk = undefined;
}
```

Delete `signalAbortHandler`, the `signal` destructuring and both `addEventListener` / `removeEventListener` calls from this generator.

> **Known dependency, do not solve here:** this `while` never settles if the worker died. That is B2 (per-request timeouts), wave 2.

- [ ] **Step 4: Write `chunk()` and its derivations in `queries.ts`**

```ts
/**
 * The single query primitive. Every other read path is a thin derivation, and
 * abort is implemented here exactly once.
 */
export const chunk = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { chunkSize?: number; signal?: AbortSignal },
): AsyncGenerator<T[]> {
  const { signal, chunkSize } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted, and
  // nothing else checks. Without this the query runs to completion.
  if (signal?.aborted) throw signal.reason;

  let aborted = false;
  const onAbort = () => {
    aborted = true;
  };
  signal?.addEventListener('abort', onAbort);

  try {
    for await (const item of worker.query<T>(sql, params, { chunkSize })) {
      // FLK-1: chunks already sitting in the message queue are NOT delivered.
      // Stopping the worker is not enough — it races ahead of the abort flag.
      if (aborted) break;
      if (typeof item !== 'number') yield item;
    }
    if (aborted) throw signal?.reason;
  } finally {
    // In the finally, never after the loop: every early exit skipped it before,
    // and first() exits early by construction.
    signal?.removeEventListener('abort', onAbort);
  }
};

export const streamRows = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { chunkSize?: number; signal?: AbortSignal },
): AsyncGenerator<T> {
  for await (const rows of chunk<T>(worker, sql, params, options)) {
    for (const row of rows) yield row;
  }
};

export const readWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { chunkSize?: number; signal?: AbortSignal },
): Promise<T[]> => {
  const result: T[] = [];
  for await (const rows of chunk<T>(worker, sql, params, options)) {
    result.push(...rows);
  }
  return result;
};

/**
 * First row, then stop. This BREAKS rather than aborting: a break triggers the
 * generator's return path, which runs chunk()'s finally and the transport's
 * stop-and-drain — the same worker-stop routine, reached without an exception.
 * That is why there is no internal AbortController here and no need to tell an
 * internal abort from the caller's.
 */
export const firstWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { signal?: AbortSignal },
): Promise<T | undefined> => {
  for await (const rows of chunk<T>(worker, sql, params, { ...options, chunkSize: 1 })) {
    return rows[0];
  }
  return undefined;
};

export const writeWorker = async <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { signal?: AbortSignal },
): Promise<{ result: T[]; affected: number }> => {
  const result: T[] = [];
  let affected = 0;
  // write() is the only caller that needs the affected count, which is why the
  // T[] | number union stays private to this module.
  for await (const item of worker.query<T>(sql, params, {})) {
    if (typeof item === 'number') affected = item;
    else result.push(...item);
  }
  return { result, affected };
};
```

> `writeWorker` bypasses `chunk()` deliberately — it is the one derivation that needs the raw union. Its `signal` handling is added in Task 6 together with the public renames; for now it accepts and ignores `options`.

- [ ] **Step 5: Expose `chunk` on the public surface**

**Delete `oneWorker`** — `firstWorker` replaces it; no call site may keep the old name.

In `client.ts`, add the `chunk` method with the same acquire/delegate/release shape as `read` (it is a generator, so `try { yield* … } finally { lease.release() }`), and point `stream` at `streamRows`. Add `chunk` and `first` to the `SQLiteDB` type.

`one` and `first` **both exist after this task** and both delegate to `firstWorker` — `first` because Task 4's tests call it, `one` because the rest of the suite still does. Task 7 deletes `one`. This overlap is deliberate and lasts exactly two tasks.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test:browser`
Expected: PASS, including all four new INT-09 tests. B9's pin is gone.

- [ ] **Step 7: Verify**

Run: `pnpm check && npx tsc --noEmit && pnpm test`
Expected: all green, no `it.fails` remaining in the suite.

- [ ] **Step 8: Commit**

```bash
git add src/pool.ts src/queries.ts src/client.ts tests/browser/concurrency.test.ts
git commit -m "fix(queries): relayer on chunk(), implement abort once — B9, FLK-1

chunk() checks an already-aborted signal up front (B9), stops yielding
the moment the signal fires rather than draining what the worker already
queued (FLK-1, now deterministic), removes its listener in the finally
(it was skipped on every early exit, i.e. every one() call), and waits
for the in-flight done before the lease returns.

first() breaks instead of aborting, so there is no internal abort to tell
apart from the caller's and AbortSignal.any is not needed."
```

---

## Task 5: Extract `transaction.ts`

**Files:**
- Create: `src/transaction.ts`
- Modify: `src/client.ts`

**Interfaces:**
- Consumes: `Lease` (Task 1), `PoolWorker` (Task 2), the derivations (Task 4).
- Produces: `createTransaction(deps: { scheduler: Scheduler<PoolWorker> }): SQLiteDB['transaction']`

- [ ] **Step 1: Move `transaction` (`client.ts:896-975`) into `src/transaction.ts`**

Behaviour unchanged from Task 2's lease conversion. Apply these corrections, all of which the spec §7.1 names:

```ts
// COMMIT / ROLLBACK / BEGIN return no rows. Going through firstWorker meant
// chunkSize 1 followed by a break — the whole worker-stop routine invoked for
// nothing.
const exec = async (worker: PoolWorker, sql: string) => {
  await readWorker(worker, sql);
};
```

Use `exec` for `BEGIN`, `commit()` and `rollback()`. Fix the typo `'Cannot werite in read-only transaction'` → `'Cannot write in read-only transaction'`. Replace `...args: any[]` on the four `TransactionDB` methods with real signatures:

```ts
type TransactionDB = {
  read: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) => Promise<T[]>;
  write: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) => Promise<{ result: T[]; affected: number }>;
  chunk: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) => AsyncGenerator<T[]>;
  stream: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) => AsyncGenerator<T>;
  first: <T extends Record<string, unknown>>(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) => Promise<T | undefined>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};
```

- [ ] **Step 2: Verify**

Run: `pnpm check && npx tsc --noEmit && pnpm test`
Expected: all green. `transaction.test.ts` may need `one` → `first` at its call sites; that is expected and in scope.

- [ ] **Step 3: Commit**

```bash
git add src/transaction.ts src/client.ts tests/browser/transaction.test.ts
git commit -m "refactor(transaction): own module, real signatures, exec() for BEGIN/COMMIT

Replaces ...args: any[] with typed signatures, stops routing statements
that return no rows through the first-row path, fixes the 'werite' typo."
```

---

## Task 6: Extract `bulk.ts` — the control specimen

**Files:**
- Create: `src/bulk.ts`
- Modify: `src/client.ts`

**Interfaces:**
- Consumes: the public `read` / `write` methods (not the worker-bound helpers — `bulkWrite` takes one lease per batch, which D3 requires be preserved).
- Produces: `createBulk(deps: { read: SQLiteDB['read']; write: SQLiteDB['write'] }): Pick<SQLiteDB, 'bulkWrite' | 'output'>`

- [ ] **Step 1: Move `bulkWrite` and `output` (`client.ts:763-894`) verbatim**

Including the `Schema`, `Index` and `OutputOptions` types. Bodies unchanged — B5 stays open, it is wave 3.

- [ ] **Step 2: Verify the specimen**

Run: `pnpm test:browser`
Expected: `bulk-write.test.ts` and `output.test.ts` pass **without any modification**. If either needed editing, the move was not pure — revert and redo.

- [ ] **Step 3: Verify and commit**

```bash
pnpm check && npx tsc --noEmit && pnpm test
git add src/bulk.ts src/client.ts
git commit -m "refactor(bulk): move bulkWrite and output into their own module

Verbatim move; bulk-write.test.ts and output.test.ts pass unmodified,
which is what makes this the control specimen for the split."
```

---

## Task 7: The public renames

**Files:**
- Modify: `src/client.ts`, `src/queries.ts`
- Modify: `tests/browser/queries.test.ts`, `tests/browser/init.test.ts` and any other caller

- [ ] **Step 1: Delete `one` from the public surface**

Task 4 left `one` and `first` side by side, both delegating to `firstWorker`. Remove `one` from the `SQLiteDB` type, from `client.ts`, and from every caller in `tests/` — use Serena's `find_referencing_symbols` on `one` to enumerate them, then `rename` so no reference is missed. `first()` returns the first row of a result set; it never asserted that exactly one row matched, which is what `one` implied.

- [ ] **Step 2: Make `stream()` yield rows, not chunks**

`stream` points at `streamRows`. Update the `SQLiteDB` JSDoc: it yields `T`, and `chunk()` is the chunk-wise path.

- [ ] **Step 3: Align the options types**

`signal` on every method — including `first`, which excluded it via `Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>`. `chunkSize` on `chunk` and `read` only. Delete `SQLiteStreamOptions` (`client.ts:65-68`): it is `SQLiteQueryOptions<T> & { signal?: AbortSignal }` where `signal` is already present — a no-op intersection.

- [ ] **Step 4: Correct the `first()` JSDoc**

It currently claims it "aborts after receiving first result for efficiency". True statement: it *asks* the worker to stop after the first row. The worker races ahead between the first chunk and the client's flag write, so on a small result set it saves nothing. The hard bound arrives with BP-1 in wave 4.

- [ ] **Step 5: Verify and commit**

```bash
pnpm check && npx tsc --noEmit && pnpm test
git add -A src tests
git commit -m "feat(api)!: rename one() to first(), stream() yields rows

stream() yielded T[] and was routinely consumed with a nested loop; it now
yields T and chunk() is the chunk-wise path. Both are silent breaks for an
untyped consumer, accepted: rc.3 has no consumer.

signal is accepted on every method, chunkSize narrowed to chunk() and read()."
```

---

## Task 8: `W-route` first half — the routing allowlist

**Files:**
- Modify: `src/utils.ts`
- Create: `tests/browser/routing.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from '@rstest/core';
import { isReadQuery } from '../../src/utils';

describe('routing (W-route)', () => {
  const writes = [
    'VACUUM',
    'ALTER TABLE t ADD COLUMN c INTEGER',
    'ANALYZE',
    'REINDEX',
    'SAVEPOINT sp1',
    'BEGIN',
    'INSERT INTO t VALUES (1)',
    'CREATE TABLE t (a INTEGER)',
  ];
  for (const sql of writes) {
    it(`routes to the writer: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(false);
    });
  }

  const reads = [
    'SELECT 1',
    '  select * from t',
    'EXPLAIN SELECT 1',
    'WITH x AS (SELECT 1) SELECT * FROM x',
  ];
  for (const sql of reads) {
    it(`routes to a reader: ${sql}`, () => {
      expect(isReadQuery(sql)).toBe(true);
    });
  }

  it('routes an unknown statement to the writer', () => {
    // The allowlist fails safe: a misclassification costs throughput, never
    // exclusivity. A blocklist would misroute every future SQLite keyword.
    expect(isReadQuery('FROBNICATE t')).toBe(false);
  });
});
```

Place this file under `tests/unit/routing.test.ts` (it needs no browser) — adjust the import path to `../../src/utils`.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test:unit`
Expected: FAIL — `isReadQuery` is not exported.

- [ ] **Step 3: Implement**

```ts
/**
 * Routing predicate: is this statement provably a read?
 *
 * Deliberately an allowlist. The previous blocklist missed VACUUM, ALTER,
 * ANALYZE, REINDEX, SAVEPOINT and a manual BEGIN, which therefore ran on the
 * read pool — a VACUUM could execute on an arbitrary worker while the writer
 * held an open transaction, bypassing exclusivity one layer above the pool.
 *
 * A misclassification now fails toward the writer: correct, merely slower.
 */
export const isReadQuery = (sql: string) =>
  /^\s*(SELECT|EXPLAIN|VALUES|WITH\b[\s\S]*?\bSELECT)\b/i.test(sql);
```

Keep `isWriteQuery` exported as `(sql: string) => !isReadQuery(sql)` so existing call sites and `utils.test.ts` keep compiling, then update the call sites in `client.ts` to `isReadQuery(sql) ? 'read' : 'write'`.

- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: all green. If a browser test now routes differently and fails, that is this commit's blast radius — read the failure before changing anything, and fix the test only if the new routing is correct.

- [ ] **Step 5: Verify and commit**

```bash
pnpm check && npx tsc --noEmit && pnpm test
git add src/utils.ts src/client.ts tests/unit/routing.test.ts
git commit -m "fix(routing): allowlist reads instead of blocklisting writes — W-route

VACUUM, ALTER, ANALYZE, REINDEX, SAVEPOINT and a manual BEGIN routed to
the read pool, so they could run on any worker while the writer held an
open transaction — the B1 guarantee breached one layer up.

Unknown statements now route to the writer: correct, merely slower."
```

---

## Task 9: Close the wave

- [ ] **Step 1: Confirm the exit criteria**

Check each, with evidence:
1. No `it.fails` remains in the suite: `grep -rn "it.fails" tests/`
2. FLK-1 fixed client-side — the abort check is in `chunk()`, not only worker-side.
3. Routing cannot bypass exclusivity (Task 8's tests, each statement named).
4. `INT-09` asserts an exact chunk count.
5. The in-flight `done` is awaited before the lease returns.

- [ ] **Step 2: Run `INT-09` repeatedly to confirm FLK-1 is gone**

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do pnpm test:browser 2>&1 | tail -3; done
```
Expected: ten identical green runs. This is the only direct evidence that the flake is gone.

- [ ] **Step 3: Update the memories**

`.serena/memories/follow-ups.md`: B1, B9, FLK-1 and the listener leak → **done**, with evidence. `W-route` half 1 → done, half 2 still open for wave 2. `W-arch` → done. `W-types` → partially done.
`.serena/memories/resume-plan.md`: §0 and §4 — wave 1 closed, wave 2 next.

- [ ] **Step 4: Merge**

Per `mem:resume-plan` §3, a phase closes only when CI is green, memories are updated and git is clean. Then merge `wave-1-pool-scheduler` into `main`.

---

## Self-Review

**Spec coverage.** §4 layout → Tasks 1-6. §5 scheduler → Task 1. §6.1-6.2 → Task 4. §6.3 `first()` breaks → Task 4 Step 4. §6.4 ack → Task 4 Step 3. §6.5 W-route → Task 8. §7.1 transaction → Task 5. §7.2 bulk → Task 6. §8.1 unit tests → Task 1 Step 2. §8.2 browser tests → Tasks 2, 4. §9 sequencing → task order. §10 done → Task 9.

**Deviation from the spec's §9, flagged deliberately.** The spec ordered "pure moves first", scheduler included. This plan writes `scheduler.ts` first, already in lease form, because it is the one module being redesigned — moving it and then rewriting it would mean writing it twice. The principle is preserved where it pays: `queries.ts` moves verbatim (Task 3) before receiving the abort semantics (Task 4), and `bulk.ts` is a pure move that must leave its tests untouched.

**Latent defect found while specifying Task 1.** `releaseWorker` served a queued writer without claiming the designation when `currentWriterIndex` was `-1`, so a later write acquisition could designate a second writer. Fixed in the scheduler with a named regression test. Not in the spec; same family as B1.

**Type consistency.** `Lease<W>` / `Scheduler<W>` (Task 1) are used verbatim in Tasks 2, 5. `PoolWorker` (Task 2) has no `available` field anywhere after Task 2. `readWorker` / `writeWorker` keep their names across Tasks 3-5; `oneWorker` becomes `firstWorker` in Task 4 and `one` becomes `first` publicly in Task 7 — the internal rename lands before the public one so no task references a name that does not yet exist.
