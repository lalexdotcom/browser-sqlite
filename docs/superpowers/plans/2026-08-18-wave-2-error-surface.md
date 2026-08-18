# Wave 2 — Error Surface, Worker Lifecycle and a Real `close()` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every failure observable and every internal wait bounded — a dead worker rejects its caller and restarts under a bound, a failed open is reported as a failure, and `close()` really closes the database.

**Architecture:** Two new pure modules carry the decisions: `supervisor.ts` decides what happens to a slot that died, and `scheduler.ts` gains `remove()` / `shutdown()` so a corpse cannot re-enter the pool and a closing client can reject its queue. `pool.ts` executes those decisions and owns the three detection signals (`onerror`, `onmessageerror`, timeout). `queries.ts` gains a prompt abort, and the caller stops waiting for the worker's stop-and-drain: the lease returns when the worker confirms it is idle. `client.ts` wires the three together and gains a real `close()`.

**Tech Stack:** TypeScript 7.0.2 (ESM only), rslib 0.23.2, rstest 0.11.8 (`unit` project = Node, `browser` project = Chromium via Playwright), biome 2.5.8, pnpm 10.31.0.

**Spec:** `docs/superpowers/specs/2026-08-18-wave-2-error-surface-design.md`

## Global Constraints

- **Language:** French in chat only. All code, comments, commit messages, docs: English.
- **Serena first.** Symbolic tools (`find_symbol`, `replace_symbol_body`, `insert_after_symbol`, `replace_content`) are PRIMARY for `.ts` files. Built-in Read/Edit/Grep on code only when Serena fails or the file is unparseable. Read/Edit are fine for `.md`, JSON, config.
- **After every modification:** `pnpm check` (biome, writes fixes).
- **Verification at every task, always wrapped in a hard timeout:**

  ```bash
  timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test
  ```

  All three must pass before committing. **Never run an unbounded test command.** Exit code 124 is a hard failure to report, not a result to wait out.
- **Test count baseline:** 151 tests green at the start (12 test files). Every task adds tests; none may go missing.
- **Falsifiability, non-negotiable.** For every test written here, state in one comment which line of production code, if deleted, makes it fail. Seven wave 1 tests passed identically with and without the behaviour they claimed to pin; this habit is what caught them. A test that cannot be made to fail is not evidence.
- **Three new client options, exact defaults:** `maxWorkerRestarts` = `1`, `openTimeout` = `30_000` ms, `drainTimeout` = `60_000` ms. No per-request timeout is added — `AbortSignal.timeout()` is the caller's bound.
- **Five error codes, exact spelling:** `NOT_A_READ_QUERY`, `CLIENT_CLOSED`, `WORKER_CRASHED`, `TIMEOUT`, `PROTOCOL_ERROR`.
- **No `CHANGELOG.md`.** `1.0.0-rc.3` has no consumer; breaking changes are recorded in `.serena/memories/`.
- **Production code gains no test seam.** Browser tests intercept `globalThis.Worker` instead. If you find yourself adding a parameter that only tests use, stop — that decision was taken and refused.
- **Out of scope, do not "fix while in there":** B4 (identifier quoting, pragma allowlist), B5 (bulk failures), B6 (debug wiring), BP-1 (back-pressure), D2 (SAB removal), `navigator.locks`.
- **Branch:** all work on `wave-2-error-surface`, never on `main`.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/errors.ts` | Create | `SQLiteError` and its `code` union. Pure, no imports. |
| `src/supervisor.ts` | Create | Pure. Per-slot restart policy: `ready` / `served` / `died` in, `restart` / `evict` / `fail-client` out. |
| `src/scheduler.ts` | Modify | Adds `remove(index)` and `shutdown(reason)`; queues carry `reject`. |
| `src/pool.ts` | Modify | Explicit slot index; `onerror` / `onmessageerror`; the drain gains a bound and a quiesce promise; `close` handshake. |
| `src/queries.ts` | Modify | Abort races the pending chunk; the caller no longer awaits the drain. |
| `src/client.ts` | Modify | Wiring: spawn / death / restart / fatal, the three options, strict routing, `close()`. |
| `src/utils.ts` | Modify | `assertReadable(sql, method)`. |
| `src/types.ts` | Modify | `close`, `closed`, `open-error` messages. |
| `src/worker/worker.ts` | Modify | `ready` on success / `open-error` on failure, defensive cause, `close` handling. |
| `src/wa-sqlite.d.ts` | Modify | Add `close`. |
| `src/index.ts` | Modify | Re-export `errors.ts`. |
| `tests/unit/errors.test.ts` | Create | The error class. |
| `tests/unit/supervisor.test.ts` | Create | The six rules. |
| `tests/unit/scheduler.test.ts` | Modify | `remove()` and `shutdown()`. |
| `tests/browser/helpers.ts` | Modify | `interceptWorkers()` — a recording `Worker` subclass. |
| `tests/browser/lifecycle.test.ts` | Create | Crash, restart, eviction, fatal client, load failure, open failure. |
| `tests/browser/close.test.ts` | Create | The `close()` handshake. |
| `tests/browser/routing.test.ts` | Modify | Strictness on the four read-shaped methods. |
| `tests/browser/long-query.test.ts` | Create | The long `step()`: not killed, prompt abort, worker not terminated. |

---

### Task 1: `SQLiteError` and the protocol messages

**Files:**
- Create: `src/errors.ts`
- Modify: `src/types.ts`, `src/index.ts`
- Test: `tests/unit/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SQLiteError` (class, `code` + `name` + `cause`), `SQLiteErrorCode` (union of the five codes), and the `close` / `closed` / `open-error` message shapes used by Tasks 6 and 8.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/errors.test.ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';

describe('SQLiteError', () => {
  // Falsifiable: delete `this.name = code` in errors.ts and this fails.
  it('mirrors the code into name so err.name reads like AbortError', () => {
    const error = new SQLiteError('CLIENT_CLOSED', 'closed');
    expect(error.name).toBe('CLIENT_CLOSED');
    expect(error.code).toBe('CLIENT_CLOSED');
  });

  // Falsifiable: drop the `options` argument from the super() call and this fails.
  it('keeps the original error as cause', () => {
    const cause = new Error('boom');
    const error = new SQLiteError('WORKER_CRASHED', 'worker died', { cause });
    expect(error.cause).toBe(cause);
  });

  it('is an Error', () => {
    expect(new SQLiteError('TIMEOUT', 'late')).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `timeout -k 30 120 pnpm test:unit`
Expected: FAIL — `src/errors` cannot be resolved.

- [ ] **Step 3: Write `src/errors.ts`**

```ts
/**
 * Every failure this library raises on its own behalf. A caller discriminates
 * on `code`, or on `name` — they carry the same value, so `err.name` reads the
 * way `'AbortError'` does on the DOMException an aborted signal throws.
 */
export type SQLiteErrorCode =
  | 'NOT_A_READ_QUERY'
  | 'CLIENT_CLOSED'
  | 'WORKER_CRASHED'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR';

export class SQLiteError extends Error {
  readonly code: SQLiteErrorCode;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
  }
}
```

- [ ] **Step 4: Extend the wire protocol**

In `src/types.ts`, add to `ClientMessageData`:

```ts
  | { type: 'close'; callId: number }
```

and to `WorkerMessageData`:

```ts
  | { type: 'closed'; callId: number }
  | {
      type: 'open-error';
      callId: number;
      message: string;
      cause?: unknown;
    }
```

Note: exhaustive `default: const _x: never` checks on the two dispatches land in Task 8, once every message has a handler. Adding them here would not compile.

- [ ] **Step 5: Re-export from the package entry**

`src/index.ts` becomes:

```ts
export * from './client';
export * from './errors';
```

- [ ] **Step 6: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS, 154 tests.

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts src/types.ts src/index.ts tests/unit/errors.test.ts
git commit -m "feat(errors): SQLiteError with a code discriminant, plus the close/open-error messages"
```

---

### Task 2: `scheduler.remove()` and `scheduler.shutdown()`

**Files:**
- Modify: `src/scheduler.ts`
- Test: `tests/unit/scheduler.test.ts`

**Interfaces:**
- Consumes: `SQLiteError` (Task 1) — in tests only; the scheduler takes any `Error`.
- Produces:
  - `remove(index: number): void`
  - `shutdown(reason: Error): Promise<void>` — resolves when the last outstanding lease has come back.
  - `Scheduler<W>` keeps `add` and `acquire` unchanged in signature; `acquire` now rejects with `reason` once shut down.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/scheduler.test.ts`:

```ts
describe('scheduler — removal', () => {
  // Falsifiable: delete `dead.add(index)` in remove() and this fails — the late
  // release() hands a corpse back and the second acquire resolves.
  it('does not hand back a removed worker when its lease is released late', async () => {
    const { scheduler } = makeScheduler(1);
    const lease = await scheduler.acquire('read');
    scheduler.remove(0);
    let served = false;
    void scheduler.acquire('read').then(() => {
      served = true;
    });
    lease.release();
    await flush();
    expect(served).toBe(false);
  });

  // Falsifiable: delete the `currentWriterIndex = -1` line in remove().
  it('frees the writer designation when the writer is removed', async () => {
    const { scheduler } = makeScheduler(2);
    const writer = await scheduler.acquire('write');
    expect(writer.worker.index).toBe(0);
    writer.release();
    scheduler.remove(0);
    const next = await scheduler.acquire('write');
    expect(next.worker.index).toBe(1);
  });

  it('revives an index when a replacement is added', async () => {
    const { scheduler } = makeScheduler(1);
    scheduler.remove(0);
    scheduler.add({ index: 0 });
    const lease = await scheduler.acquire('read');
    expect(lease.worker.index).toBe(0);
  });
});

describe('scheduler — shutdown', () => {
  // Falsifiable: delete the reject loop over the queues in shutdown().
  it('rejects queued waiters with the given reason', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const queued = scheduler.acquire('read');
    const reason = new Error('closing');
    void scheduler.shutdown(reason);
    await expect(queued).rejects.toBe(reason);
    held.release();
  });

  // Falsifiable: delete the `if (shutdownReason) throw shutdownReason` guard in acquire().
  it('rejects every later acquisition', async () => {
    const { scheduler } = makeScheduler(1);
    const reason = new Error('closing');
    void scheduler.shutdown(reason);
    await expect(scheduler.acquire('read')).rejects.toBe(reason);
  });

  // Falsifiable: resolve the shutdown promise immediately instead of waiting on
  // `leased.size === 0` and this fails.
  it('settles only when the last outstanding lease comes back', async () => {
    const { scheduler } = makeScheduler(2);
    const a = await scheduler.acquire('read');
    const b = await scheduler.acquire('read');
    let settled = false;
    void scheduler.shutdown(new Error('closing')).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    a.release();
    await flush();
    expect(settled).toBe(false);
    b.release();
    await flush();
    expect(settled).toBe(true);
  });

  // Falsifiable: drop the `leased.delete(index)` line from remove() — the
  // shutdown promise then waits forever on a lease nobody can return.
  it('does not wait on a lease whose worker was removed', async () => {
    const { scheduler } = makeScheduler(1);
    await scheduler.acquire('read');
    let settled = false;
    void scheduler.shutdown(new Error('closing')).then(() => {
      settled = true;
    });
    scheduler.remove(0);
    await flush();
    expect(settled).toBe(true);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 120 pnpm test:unit`
Expected: FAIL — `scheduler.remove is not a function`.

- [ ] **Step 3: Implement**

Rewrite the body of `createScheduler` in `src/scheduler.ts`. Changes only, everything else preserved verbatim:

```ts
export type Scheduler<W> = {
  add: (worker: W) => void;
  acquire: (kind: 'read' | 'write') => Promise<Lease<W>>;
  /**
   * Takes a worker out of the pool for good. A lease already outstanding on
   * that index becomes inert: its `release()` neither hands the worker back nor
   * counts towards `shutdown()`'s wait.
   */
  remove: (index: number) => void;
  /**
   * Closes the front door. Queued waiters reject with `reason`, later
   * acquisitions reject the same way, and the returned promise settles when the
   * last outstanding lease has come back.
   */
  shutdown: (reason: Error) => Promise<void>;
};
```

Inside the factory, next to `available`:

```ts
  const workers: (W | undefined)[] = [];
  const dead = new Set<number>();
  const leased = new Set<number>();
  let shutdownReason: Error | undefined;
  let shutdownDeferred: PromiseWithResolvers<void> | undefined;

  const checkShutdown = () => {
    if (shutdownDeferred && leased.size === 0) shutdownDeferred.resolve();
  };
```

Queues become `Array<{ resolve: (worker: W) => void; reject: (error: Error) => void }>`, and every `queue.shift()?.(worker)` becomes `queue.shift()?.resolve(worker)`.

`takeAvailable`'s scan tolerates holes:

```ts
    const found = workers.find(
      (worker) => worker !== undefined && available.has(worker.index),
    );
```

`makeLease` books the lease and honours removal:

```ts
  const makeLease = (worker: W): Lease<W> => {
    leased.add(worker.index);
    let released = false;
    return {
      worker,
      release: () => {
        if (released) return;
        released = true;
        // A worker removed while leased is already accounted for; handing it
        // back would put a corpse in the pool.
        const stillOurs = leased.delete(worker.index);
        if (stillOurs && !dead.has(worker.index)) handOver(worker);
        checkShutdown();
      },
    };
  };
```

`add` revives an index, `remove` and `shutdown` are new, `acquire` grows one guard:

```ts
    add: (worker) => {
      dead.delete(worker.index);
      workers[worker.index] = worker;
      // ... existing body unchanged ...
    },

    remove: (index) => {
      dead.add(index);
      available.delete(index);
      leased.delete(index);
      workers[index] = undefined;
      if (currentWriterIndex === index) currentWriterIndex = -1;
      checkShutdown();
    },

    shutdown: (reason) => {
      shutdownReason ??= reason;
      shutdownDeferred ??= Promise.withResolvers<void>();
      for (const waiter of readerQueue.splice(0)) waiter.reject(reason);
      for (const waiter of writerQueue.splice(0)) waiter.reject(reason);
      checkShutdown();
      return shutdownDeferred.promise;
    },

    acquire: async (kind) => {
      if (shutdownReason) throw shutdownReason;
      // ... existing body, with the queue push becoming:
      // (write ? writerQueue : readerQueue).push({ resolve, reject });
    },
```

- [ ] **Step 4: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS. The pre-existing scheduler tests must pass **unmodified** — they are the control specimen for this rewrite.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/unit/scheduler.test.ts
git commit -m "feat(scheduler): remove() and shutdown(), queues carrying reject"
```

---

### Task 3: `supervisor.ts`

**Files:**
- Create: `src/supervisor.ts`
- Test: `tests/unit/supervisor.test.ts`

**Interfaces:**
- Consumes: nothing. No `Worker`, no DOM, no orchestrator import — this module must stay Node-pure.
- Produces:
  - `createSupervisor(options: { size: number; maxWorkerRestarts?: number }): Supervisor`
  - `Supervisor = { report: (index: number, event: 'ready' | 'served' | 'died') => SupervisorDecision | undefined }`
  - `SupervisorDecision = 'restart' | 'evict' | 'fail-client'`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/supervisor.test.ts
import { describe, expect, it } from '@rstest/core';
import { createSupervisor } from '../../src/supervisor';

describe('supervisor — R1: a slot that never reported ready is never restarted', () => {
  // Falsifiable: delete the `if (!slot.everReady) return evict(...)` branch.
  it('evicts a slot that dies before its first ready', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict');
  });
});

describe('supervisor — R2: the counter resets on a served request, not on ready', () => {
  // THE decisive test. Falsifiable: move the counter reset from the 'served'
  // branch to the 'ready' branch and this loops instead of stopping.
  it('stops a slot that boots fine and dies on every request', () => {
    const supervisor = createSupervisor({ size: 1, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('fail-client');
  });

  it('gives a slot its budget back once it has actually served something', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    supervisor.report(0, 'served');
    expect(supervisor.report(0, 'died')).toBe('restart');
  });
});

describe('supervisor — R3/R4: the bound', () => {
  it('honours maxWorkerRestarts', () => {
    const supervisor = createSupervisor({ size: 2, maxWorkerRestarts: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('evict');
  });

  it('defaults to a single restart', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('evict');
  });
});

describe('supervisor — R5: the last slot', () => {
  // Falsifiable: delete the live-count check that upgrades 'evict' to 'fail-client'.
  it('fails the client when eviction leaves no live slot', () => {
    const supervisor = createSupervisor({ size: 2 });
    expect(supervisor.report(0, 'died')).toBe('evict');
    expect(supervisor.report(1, 'died')).toBe('fail-client');
  });

  it('does not fail the client while a restart is pending', () => {
    const supervisor = createSupervisor({ size: 1 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
  });
});

describe('supervisor — a second death report on the same slot', () => {
  // Falsifiable: delete the `if (!slot.alive) return undefined` guard — a
  // duplicate report then burns a restart, and onerror plus a drain timeout on
  // the same worker is an ordinary double report.
  it('is ignored', () => {
    const supervisor = createSupervisor({ size: 2 });
    supervisor.report(0, 'ready');
    expect(supervisor.report(0, 'died')).toBe('restart');
    expect(supervisor.report(0, 'died')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 120 pnpm test:unit`
Expected: FAIL — `src/supervisor` cannot be resolved.

- [ ] **Step 3: Implement**

```ts
/**
 * Pure restart policy for worker slots.
 *
 * Deliberately free of `Worker`, DOM and orchestrator imports so Node tests can
 * drive it in milliseconds — the same reason `scheduler.ts` is pure. B1 lived
 * for months because the only way to reach the pool's decisions was a browser.
 *
 * The caller reports facts; this module returns a decision and never acts.
 */
export type SupervisorDecision = 'restart' | 'evict' | 'fail-client';

export type Supervisor = {
  report: (
    index: number,
    event: 'ready' | 'served' | 'died',
  ) => SupervisorDecision | undefined;
};

type Slot = { everReady: boolean; alive: boolean; restarts: number };

export const createSupervisor = (options: {
  size: number;
  maxWorkerRestarts?: number;
}): Supervisor => {
  const { size, maxWorkerRestarts = 1 } = options;

  const slots: Slot[] = Array.from({ length: size }, () => ({
    everReady: false,
    alive: true,
    restarts: 0,
  }));

  const liveCount = () => slots.filter((slot) => slot.alive).length;

  return {
    report: (index, event) => {
      const slot = slots[index];
      if (!slot) return undefined;

      if (event === 'ready') {
        slot.everReady = true;
        slot.alive = true;
        // Deliberately NOT resetting `restarts`: a worker that boots fine and
        // dies on every query would otherwise restart forever, silently.
        return undefined;
      }

      if (event === 'served') {
        slot.restarts = 0;
        return undefined;
      }

      // 'died' — a slot already counted as dead reports once per signal
      // (onerror and a drain timeout can both fire), so ignore repeats.
      if (!slot.alive) return undefined;
      slot.alive = false;

      // R1: a slot that never worked is a configuration error, not an
      // accident. Restarting it only delays the diagnostic.
      if (slot.everReady && slot.restarts < maxWorkerRestarts) {
        slot.restarts += 1;
        return 'restart';
      }

      return liveCount() === 0 ? 'fail-client' : 'evict';
    },
  };
};
```

- [ ] **Step 4: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor.ts tests/unit/supervisor.test.ts
git commit -m "feat(supervisor): pure per-slot restart policy, six rules under Node test"
```

---

### Task 4: `createPoolWorker` takes an explicit index

**Files:**
- Modify: `src/pool.ts:37-64`, `src/client.ts:431-444`

**Interfaces:**
- Consumes: nothing new.
- Produces: `createPoolWorker(deps: { index: number; orchestrator; pool; clientPrefix; file; vfs; pragmas? }): Promise<PoolWorker>` — the index is now given, not derived. `pool` becomes `(PoolWorker | undefined)[]`.

Pure refactor: no behaviour change, no new test. Its correctness is carried by the 151 existing tests.

- [ ] **Step 1: Change the signature**

In `src/pool.ts`, replace the creation block:

```ts
  const workerName = `${clientPrefix} / Worker ${index + 1}`;
  const worker = Object.assign(
    new Worker(
      /* webpackChunkName: "browser-sqlite" */ new URL(
        './worker/worker.js',
        import.meta.url,
      ),
      { name: workerName, type: 'module' },
    ) as PoolWorker,
    { index },
  );
  pool[index] = worker;
```

`index` comes from `deps`; `pool.push` disappears. A restart must reuse the dead slot's index — the orchestrator's status byte, the `pool` cell and the writer designation are all index-keyed.

- [ ] **Step 2: Update the caller**

In `src/client.ts`, the pool array becomes `const pool: (PoolWorker | undefined)[] = []` and the init loop passes the index:

```ts
  Promise.all(
    Array.from({ length: poolSize }, (_, index) =>
      createPoolWorker({
        index,
        orchestrator,
        pool,
        clientPrefix,
        file,
        vfs,
        pragmas: clientOptions?.pragmas,
      }),
    ),
  ).then((allWorkers) => {
    for (const worker of allWorkers) scheduler.add(worker);
  });
```

`close()`'s `pool.shift()` loop becomes an index walk that tolerates holes:

```ts
  const close = () => {
    for (const worker of pool) worker?.terminate();
    pool.length = 0;
  };
```

- [ ] **Step 3: Verify nothing moved**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS, still 154 tests. A failure here is a move bug, not a policy bug — that is why this task is separate.

- [ ] **Step 4: Commit**

```bash
git add src/pool.ts src/client.ts
git commit -m "refactor(pool): slots are addressed by an explicit index"
```

---

### Task 5: Crash detection and the restart loop

**Files:**
- Modify: `src/pool.ts`, `src/client.ts`
- Modify: `tests/browser/helpers.ts`
- Test: `tests/browser/lifecycle.test.ts` (create)

**Interfaces:**
- Consumes: `SQLiteError` (Task 1), `scheduler.remove` / `shutdown` (Task 2), `createSupervisor` (Task 3), the explicit index (Task 4).
- Produces:
  - `createPoolWorker` gains `onDeath?: (index: number, error: SQLiteError) => void` and `onServed?: (index: number) => void` in `deps`.
  - `CreateSQLiteClientOptions` gains `maxWorkerRestarts?: number` (default `1`).
  - `interceptWorkers(options?: { url?: string }): WorkerRecord[]` in the browser helpers, where `WorkerRecord = { worker: Worker; posted: string[]; received: string[]; log: string[]; terminated: boolean }`.

- [ ] **Step 1: Add the test helper**

Append to `tests/browser/helpers.ts`:

```ts
export type WorkerRecord = {
  worker: Worker;
  posted: string[];
  received: string[];
  /** Ordered trace: 'post:<type>', 'recv:<type>', 'terminate'. */
  log: string[];
  terminated: boolean;
};

/**
 * Records every Worker the client creates, and optionally redirects them to
 * another URL so a load failure can be produced for real.
 *
 * Production code has no test seam by design: the tests reach the workers by
 * replacing the constructor the client calls, not by asking the client to
 * accept a factory.
 */
export function interceptWorkers(options?: { url?: string }): WorkerRecord[] {
  const records: WorkerRecord[] = [];
  const Original = globalThis.Worker;

  class Recording extends Original {
    constructor(url: string | URL, workerOptions?: WorkerOptions) {
      super(options?.url ?? url, workerOptions);
      const record: WorkerRecord = {
        worker: this,
        posted: [],
        received: [],
        log: [],
        terminated: false,
      };
      records.push(record);
      this.addEventListener('message', (event: MessageEvent) => {
        const type = String((event.data as { type?: string })?.type);
        record.received.push(type);
        record.log.push(`recv:${type}`);
      });
      const post = this.postMessage.bind(this);
      this.postMessage = (message: unknown, ...rest: unknown[]) => {
        const type = String((message as { type?: string })?.type);
        record.posted.push(type);
        record.log.push(`post:${type}`);
        return (post as (m: unknown, ...r: unknown[]) => void)(message, ...rest);
      };
      const terminate = this.terminate.bind(this);
      this.terminate = () => {
        record.terminated = true;
        record.log.push('terminate');
        terminate();
      };
    }
  }

  globalThis.Worker = Recording as unknown as typeof Worker;
  afterEach(() => {
    globalThis.Worker = Original;
  });
  return records;
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A single very long `sqlite.step()` with no table to populate: SQLite must run
 * the whole recursion before the first row of `count(*)` exists.
 */
export const longQuery = (iterations: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ${iterations}) SELECT count(*) AS n FROM c`;
```

- [ ] **Step 2: Write the failing tests**

```ts
// tests/browser/lifecycle.test.ts
import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

describe('worker lifecycle — crash detection', () => {
  // Falsifiable: delete `worker.onerror = ...` in pool.ts and this hangs until
  // the test timeout instead of rejecting.
  it('rejects the in-flight query when the worker reports an uncaught error', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(
      new ErrorEvent('error', { message: 'simulated worker failure' }),
    );

    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
  });

  // Falsifiable: return 'evict' instead of 'restart' from the supervisor, or
  // drop the `if (decision === 'restart') void spawn(index)` branch in client.ts.
  it('restarts the slot once and keeps serving', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    expect(records.length).toBe(1);

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });

    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });

  // Falsifiable: delete the `fail()` call on the 'fail-client' decision.
  it('fails the client permanently once the restart budget is spent', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, maxWorkerRestarts: 1 });
    await db.write('CREATE TABLE t (a)');

    for (const attempt of [0, 1]) {
      const running = db.read(longQuery(20_000_000));
      await sleep(100);
      records[attempt].worker.dispatchEvent(new ErrorEvent('error'));
      await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
      if (attempt === 0) await sleep(300); // let the replacement reach ready
    }

    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
  });

  // Falsifiable: replace the load-failure message with a bare 'worker error'.
  it('names the URL it failed to load', async () => {
    interceptWorkers({ url: '/definitely-missing-worker.js' });
    const db = await createTestClient({ poolSize: 1 });

    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
      message: expect.stringContaining('definitely-missing-worker.js'),
    });
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      message: expect.stringContaining('Bundler Configuration'),
    });
  });

  // Falsifiable: delete `worker.onmessageerror` — the query then hangs.
  // Note: synthetic. Producing a genuinely undeserializable message on demand
  // is not achievable cleanly; the handler is exercised, not the browser's path
  // into it.
  it('rejects the in-flight query on a deserialization failure, and keeps the worker', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0].worker.dispatchEvent(new MessageEvent('messageerror'));

    await expect(running).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
    expect(records[0].terminated).toBe(false);
    expect(records.length).toBe(1);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `timeout -k 30 600 pnpm test:browser`
Expected: FAIL — the queries hang until the 30 s per-test bound.

- [ ] **Step 4: Implement the transport half**

In `src/pool.ts`: keep a death signal, race it, and report.

```ts
  let dead = false;
  let ready = false;
  const deathDeferred = Promise.withResolvers<never>();
  // Nothing awaits this until a query runs; without a sink an early death is an
  // unhandled rejection.
  deathDeferred.promise.catch(() => {});

  // Per-query channel for a message that never arrived (onmessageerror). The
  // worker is alive, so the request rejects but the transport stays intact and
  // the generator's finally still stops and drains it.
  let lost: PromiseWithResolvers<never> | undefined;

  const workerUrl = new URL('./worker/worker.js', import.meta.url).href;

  const die = (error: SQLiteError) => {
    if (dead) return;
    dead = true;
    deathDeferred.reject(error);
    deferredInit.reject(error); // no-op once resolved
    deps.onDeath?.(index, error);
  };

  worker.onerror = (event) => {
    const detail =
      typeof event === 'object' && event !== null && 'message' in event
        ? String((event as ErrorEvent).message ?? '')
        : '';
    die(
      new SQLiteError(
        'WORKER_CRASHED',
        ready
          ? `Worker ${index + 1} failed: ${detail || 'uncaught error'}`
          : `browser-sqlite could not load its worker from ${workerUrl}. ` +
            `If that URL 404s, your bundler did not emit the worker beside your build output — ` +
            `see the "Bundler Configuration" section of the browser-sqlite README. ${detail}`,
        { cause: event },
      ),
    );
  };

  worker.onmessageerror = () => {
    lost?.reject(
      new SQLiteError(
        'PROTOCOL_ERROR',
        `Worker ${index + 1} sent a message that could not be deserialized; the request cannot be completed.`,
      ),
    );
  };
```

In the `onmessage` handler, mark readiness and report a served request:

```ts
    if (callId === 0 && type === 'ready') {
      ready = true;
      if (state) state.initializationTime = Date.now();
      deferredInit.resolve(worker);
    }
```

and in the `'done'` case, after resolving the chunk deferred:

```ts
        deps.onServed?.(index);
```

In the `query` generator, create the per-query channel and race it:

```ts
      deferredChunk = Promise.withResolvers<unknown[] | number>();
      lost = Promise.withResolvers<never>();
      lost.promise.catch(() => {});

      worker.postMessage({ /* unchanged */ });

      while (deferredChunk) {
        const chunk = await Promise.race([
          deferredChunk.promise,
          lost.promise,
          deathDeferred.promise,
        ]);
        yield chunk as T[] | number;
      }
```

and guard the drain in the `finally`:

```ts
      if (deferredChunk && !dead) {
        // ... existing stop-and-drain, unchanged (bounded in Task 6) ...
      }
      deferredChunk = undefined;
      lost = undefined;
```

- [ ] **Step 5: Implement the wiring half**

In `src/client.ts`, add the option:

```ts
  /**
   * How many times a worker slot may be restarted after it has died.
   * A slot that never reached readiness is never restarted — an initial
   * failure is deterministic, and restarting only delays the diagnostic.
   * The counter resets once the replacement has actually served a request.
   * @defaultValue `1`
   */
  maxWorkerRestarts?: number;
```

and the lifecycle wiring, replacing the `Promise.all` init block:

```ts
  const supervisor = createSupervisor({
    size: poolSize,
    maxWorkerRestarts: clientOptions?.maxWorkerRestarts,
  });

  let fatal: SQLiteError | undefined;

  const failClient = (error: SQLiteError) => {
    fatal ??= error;
    void scheduler.shutdown(fatal);
    for (const dying of pool) dying?.terminate();
  };

  const handleDeath = (index: number, error: SQLiteError) => {
    scheduler.remove(index);
    pool[index]?.terminate();
    pool[index] = undefined;
    const decision = supervisor.report(index, 'died');
    if (decision === 'restart') spawn(index);
    else if (decision === 'fail-client') failClient(error);
  };

  const spawn = (index: number) => {
    void createPoolWorker({
      index,
      orchestrator,
      pool,
      clientPrefix,
      file,
      vfs,
      pragmas: clientOptions?.pragmas,
      onDeath: handleDeath,
      onServed: (served) => {
        supervisor.report(served, 'served');
      },
    })
      .then((worker) => {
        supervisor.report(index, 'ready');
        scheduler.add(worker);
      })
      .catch(() => {
        // The rejection is the death already reported through onDeath.
      });
  };

  for (let index = 0; index < poolSize; index += 1) spawn(index);
```

`spawn` is referenced by `handleDeath` before its declaration, so declare it as a `function` or move `handleDeath` after it — TypeScript's `const` hoisting rules apply, and this ordering is checked by `tsc`.

- [ ] **Step 6: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pool.ts src/client.ts tests/browser/helpers.ts tests/browser/lifecycle.test.ts
git commit -m "feat(pool): detect worker death, restart the slot under a bound"
```

---

### Task 6: The two bounds, and a failed open that says so

**Files:**
- Modify: `src/pool.ts`, `src/client.ts`, `src/worker/worker.ts`
- Test: `tests/browser/lifecycle.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces:
  - `CreateSQLiteClientOptions` gains `openTimeout?: number` (default `30_000`) and `drainTimeout?: number` (default `60_000`).
  - `createPoolWorker` gains `drainTimeout: number` in `deps`.
  - The worker posts `open-error` instead of `ready` when the open fails.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/lifecycle.test.ts`:

**Note on what is *not* tested here.** The drain bound's own test — a silently
killed worker that never answers the stop request — needs the prompt abort from Task 7 to
reach the drain at all: until then the caller is parked on a chunk that will never arrive.
That test lives in Task 7 Step 1. Implement the bound here; prove it there.

```ts
describe('worker lifecycle — bounds', () => {
  // Falsifiable: put `postMessage({type:'ready'})` back in a `.finally()` in
  // worker.ts — the second client then reports ready and hangs on its query.
  it('reports a failed open instead of reporting ready', async () => {
    const shared = `browser-sqlite-test-${crypto.randomUUID()}`;
    const first = createSQLiteClient(shared, {
      poolSize: 1,
      vfs: 'AccessHandlePoolVFS',
    });
    await first.write('CREATE TABLE t (a)');

    const second = createSQLiteClient(shared, {
      poolSize: 1,
      vfs: 'AccessHandlePoolVFS',
      openTimeout: 3000,
    });
    await expect(second.read('SELECT 1')).rejects.toMatchObject({
      name: expect.stringMatching(/WORKER_CRASHED|TIMEOUT/),
    });

    await first.close();
    await second.close();
  });
});
```

`createSQLiteClient` is imported directly here rather than through `createTestClient`, because both clients must name the *same* database file. Register the OPFS cleanup by hand in an `afterEach`.

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 600 pnpm test:browser`
Expected: FAIL — the first test never reclaims the slot; the second hangs.

- [ ] **Step 3: Bound the drain**

In `src/pool.ts`'s `finally`:

```ts
      if (deferredChunk && !dead) {
        orchestrator.setStatus(
          index,
          WorkerStatuses.ABORTING,
          WorkerStatuses.RUNNING,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expiry = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SQLiteError(
                  'WORKER_CRASHED',
                  `Worker ${index + 1} did not answer the stop request within ${deps.drainTimeout} ms; presumed dead.`,
                ),
              ),
            deps.drainTimeout,
          );
        });
        try {
          while (deferredChunk) {
            await Promise.race([deferredChunk.promise, expiry]);
          }
        } catch (error) {
          // A timeout is our own verdict and must be acted on. Any other error
          // is the worker reporting a failure while winding down; the caller is
          // already unwinding and surfacing it here would mask their reason.
          if (error instanceof SQLiteError && error.code === 'WORKER_CRASHED') {
            die(error);
          }
        } finally {
          clearTimeout(timer);
        }
      }
```

- [ ] **Step 4: Bound the open**

In `src/client.ts`, add both options with their defaults, and arm a per-slot timer inside `spawn`:

```ts
  const openTimeout = clientOptions?.openTimeout ?? 30_000;
  const drainTimeout = clientOptions?.drainTimeout ?? 60_000;
```

```ts
  const spawn = (index: number) => {
    const timer = setTimeout(() => {
      handleDeath(
        index,
        new SQLiteError(
          'TIMEOUT',
          `Worker ${index + 1} did not become ready within ${openTimeout} ms. ` +
            `The database may be held under an exclusive lock by another tab or another client.`,
        ),
      );
    }, openTimeout);

    void createPoolWorker({ /* ... */ drainTimeout })
      .then((worker) => { /* ... */ })
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  };
```

- [ ] **Step 5: Report a failed open**

In `src/worker/worker.ts`, replace the `.catch(e => { throw e }).finally(...)` tail of `openedDB` with an explicit success and failure path:

```ts
    .then((opened) => {
      orchestrator.unlock();
      // Transition: INITIALIZING → READY. Only on success — the previous
      // `.finally()` posted `ready` even for a database that never opened.
      orchestrator.setStatus(index, WorkerStatuses.READY);
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
    .catch((error: unknown) => {
      orchestrator.unlock();
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message: error instanceof Error ? error.message : `Failed to open ${file}`,
        cause: cloneable(error),
      });
      throw error;
    });

  // Nothing awaits openedDB until a query arrives; keep a failed open from
  // becoming an unhandled rejection in the worker.
  openedDB.catch(() => {});
```

Add the defensive cause helper next to `reply`:

```ts
/**
 * A cause that cannot be structured-cloned makes `postMessage` itself throw —
 * inside the catch block — so the client receives nothing and waits forever.
 */
const cloneable = (value: unknown): unknown => {
  try {
    structuredClone(value);
    return value;
  } catch {
    return String(value);
  }
};
```

and use it in the query error reply, replacing the raw `cause: e.cause`:

```ts
            ? { message: e.message, cause: cloneable(e.cause) }
```

- [ ] **Step 6: Handle `open-error` on the client**

In `src/pool.ts`'s `onmessage`, before the `deferredChunk` branch:

```ts
    if (callId === 0 && type === 'open-error') {
      die(
        new SQLiteError('WORKER_CRASHED', data.message, { cause: data.cause }),
      );
      return;
    }
```

- [ ] **Step 7: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/pool.ts src/client.ts src/worker/worker.ts tests/browser/lifecycle.test.ts
git commit -m "feat(pool): bound the open and the drain, report a failed open"
```

---

### Task 7: Prompt abort, and a caller that does not wait for the drain

**Files:**
- Modify: `src/queries.ts`, `src/pool.ts`, `src/client.ts`, `src/transaction.ts`
- Test: `tests/browser/long-query.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces: `PoolWorker` gains
  - `interrupt(): void` — asks the worker to stop and unblocks a `next()` already in flight. Idempotent, safe when idle.
  - `quiesce(): Promise<void>` — resolves when no query is in flight on this worker.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/browser/long-query.test.ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, longQuery, sleep } from './helpers';

describe('a long single step', () => {
  // Falsifiable: bound the query itself with any timer and this fails.
  it('runs to completion untouched', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const rows = await db.read<{ n: number }>(longQuery(2_000_000));
    expect(rows[0]?.n).toBe(2_000_000);
  });

  // Falsifiable: drop the abort from the race in chunk() and go back to testing
  // `aborted` after the await — the rejection then waits for the sort to finish
  // and this exceeds its budget.
  it('gives the caller back control at the moment the signal fires', async () => {
    const db = await createTestClient({ poolSize: 2 });
    const started = performance.now();
    await expect(
      db.read(longQuery(20_000_000), [], {
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Falsifiable: await the quiesce promise in client.ts's finally instead of
  // chaining the release on it — the second read then blocks behind the sort.
  it('does not terminate the worker it abandoned, and does not block the pool', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 2, drainTimeout: 60_000 });
    await db.write('CREATE TABLE t (a)');

    await expect(
      db.read(longQuery(20_000_000), [], { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();

    const started = performance.now();
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(records.some((record) => record.terminated)).toBe(false);
    expect(records.length).toBe(2);
  });
});

describe('a worker killed silently', () => {
  // The drain bound from Task 6, provable only now: without the prompt abort
  // the caller never reaches the drain at all.
  // Falsifiable: remove the timer from the drain race in pool.ts — the slot is
  // then never reclaimed and the last two assertions fail.
  it('is presumed dead when it never answers the stop request', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000), [], {
      signal: AbortSignal.timeout(200),
    });
    await sleep(100);
    records[0].worker.terminate(); // silent death: no event of any kind

    await expect(running).rejects.toThrow();
    await sleep(2000); // drainTimeout, then the replacement's boot
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 600 pnpm test:browser`
Expected: FAIL — the second and third tests exceed their budgets.

- [ ] **Step 3: Give the transport a stop signal and an idle promise**

In `src/pool.ts`:

```ts
const STOP = Symbol('stop');

  // Resolved while a query is in flight; `quiesce()` is how a lease learns the
  // worker is genuinely idle again.
  let idle: PromiseWithResolvers<void> | undefined;
  let stopRequested: PromiseWithResolvers<typeof STOP> | undefined;
```

In the generator, before the post:

```ts
      idle = Promise.withResolvers<void>();
      stopRequested = Promise.withResolvers<typeof STOP>();
```

race it, and break on it:

```ts
      while (deferredChunk) {
        const chunk = await Promise.race([
          deferredChunk.promise,
          stopRequested.promise,
          lost.promise,
          deathDeferred.promise,
        ]);
        if (chunk === STOP) break;
        yield chunk as T[] | number;
      }
```

and at the very end of the `finally`, after the drain:

```ts
      deferredChunk = undefined;
      lost = undefined;
      stopRequested = undefined;
      idle?.resolve();
      idle = undefined;
```

Then expose both on the worker:

```ts
  Object.assign(worker, {
    query,
    /**
     * Ask the worker to stop. Also settles a `next()` already in flight, which
     * is what lets the consumer's queued `return()` reach the generator's
     * finally instead of waiting behind a chunk that may be minutes away.
     */
    interrupt: () => {
      stopRequested?.resolve(STOP);
    },
    quiesce: () => idle?.promise ?? Promise.resolve(),
  });
```

with the matching fields on the `PoolWorker` type.

- [ ] **Step 4: Race the abort in `queries.ts`**

Replace `chunk()`'s body:

```ts
export const chunk = async function* <
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  worker: PoolWorker,
  sql: string,
  params?: unknown[],
  options?: { chunkSize?: number; signal?: AbortSignal },
): AsyncGenerator<T[]> {
  const { signal, chunkSize } = options ?? {};

  // B9: addEventListener never fires for a signal that is already aborted.
  if (signal?.aborted) throw signal.reason;

  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  // Nothing consumes this rejection when the query ends normally.
  aborted?.catch(() => {});

  const iterator = worker.query<T>(sql, params, { chunkSize });
  try {
    while (true) {
      // Racing the pending chunk, not testing a flag after it: an ORDER BY
      // sorts entirely inside the first step(), so waiting for a chunk before
      // noticing the abort makes AbortSignal.timeout(n) return minutes late.
      const next = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (next.done) break;
      // FLK-1: chunks already queued are not delivered once the signal fired.
      if (typeof next.value !== 'number') yield next.value;
    }
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    // Start the stop-and-drain, never await it. The caller must not wait for a
    // sort that may still have minutes to run; the lease returns through
    // quiesce() instead. interrupt() first, so the queued return() is not
    // parked behind a next() that will not settle.
    worker.interrupt();
    void iterator.return(undefined).catch(() => {});
  }
};
```

Apply the same race to `writeWorker`, which has its own copy of the abort loop.

- [ ] **Step 5: Release the lease on quiesce**

In `src/client.ts`, every one of the five `finally { lease.release(); }` blocks becomes:

```ts
    } finally {
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
```

`transaction.ts` releases the same way at the end of its lifetime.

- [ ] **Step 6: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS. Pay attention to `concurrency.test.ts` — it is the wave 1 abort suite and must pass unmodified.

- [ ] **Step 7: Commit**

```bash
git add src/queries.ts src/pool.ts src/client.ts src/transaction.ts tests/browser/long-query.test.ts
git commit -m "fix(queries): abort races the pending chunk; the lease returns on quiesce"
```

---

### Task 8: `close()` that really closes

**Files:**
- Modify: `src/client.ts`, `src/pool.ts`, `src/worker/worker.ts`, `src/wa-sqlite.d.ts`
- Test: `tests/browser/close.test.ts` (create)

**Interfaces:**
- Consumes: `scheduler.shutdown` (Task 2), `quiesce` (Task 7).
- Produces:
  - `SQLiteDB.close: () => Promise<void>` — was `() => void`. Breaking, and free under the standing no-consumer assumption.
  - `PoolWorker.close(): Promise<void>` — posts `close`, awaits `closed`, then terminates.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/browser/close.test.ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

describe('close()', () => {
  // Falsifiable: drop the await on the 'closed' reply in pool.ts — 'terminate'
  // then appears before 'recv:closed' in the trace.
  it('waits for the worker to close the database before terminating it', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');

    await db.close();

    const trace = records[0].log;
    expect(trace).toContain('post:close');
    expect(trace.indexOf('recv:closed')).toBeGreaterThan(
      trace.indexOf('post:close'),
    );
    expect(trace.indexOf('terminate')).toBeGreaterThan(
      trace.indexOf('recv:closed'),
    );
  });

  // Falsifiable: reject in-flight work instead of draining it.
  it('lets an in-flight write finish', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    const inFlight = db.write('INSERT INTO t (a) VALUES (1)');
    const closing = db.close();
    await expect(inFlight).resolves.toMatchObject({ affected: 1 });
    await closing;
  });

  // Falsifiable: delete the scheduler.shutdown() call in close().
  it('rejects a queued request and every later call', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    const inFlight = db.write('INSERT INTO t (a) VALUES (1)');
    const queued = db.write('INSERT INTO t (a) VALUES (2)');
    const closing = db.close();

    await expect(queued).rejects.toMatchObject({ code: 'CLIENT_CLOSED' });
    await inFlight;
    await closing;
    await expect(db.read('SELECT 1')).rejects.toMatchObject({
      code: 'CLIENT_CLOSED',
    });
  });

  // Falsifiable: rebuild the promise on each call instead of memoizing it.
  it('is idempotent', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    const first = db.close();
    const second = db.close();
    expect(first).toBe(second);
    await first;
  });

  // Falsifiable: remove the drainTimeout race around the handshake — the test
  // then hangs on the never-returning callback instead of settling.
  it('is bounded when a transaction never finishes', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');
    void db.transaction(async () => {
      await new Promise(() => {}); // never settles
    });
    await sleep(100);
    await db.close(); // must settle, not hang
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 600 pnpm test:browser`
Expected: FAIL — `db.close()` returns `undefined`, so `await db.close()` resolves instantly and the trace assertions fail.

- [ ] **Step 3: Teach the worker to close**

In `src/wa-sqlite.d.ts`, add to the `SQLiteAPI` subset:

```ts
  close(db: number): Promise<number>;
```

In `src/worker/worker.ts`, handle `close` in the query-time handler installed inside `open()`:

```ts
    if (data.type === 'close') {
      try {
        const { sqlite, db } = await openedDB!;
        await sqlite.close(db);
      } catch {
        // A database that never opened has nothing to close; the client is
        // shutting down either way and must still get its reply.
      }
      reply({ type: 'closed', callId: 0 });
      return;
    }
```

and in the top-level handler, so a `close` arriving before the open completes is still answered:

```ts
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
  const { data } = event;
  if (data.type === 'open') {
    const { file, flags, index, vfs, pragmas } = data;
    open(file, flags, index, { vfs, pragmas });
    return;
  }
  if (data.type === 'close') {
    self.postMessage({ type: 'closed', callId: 0 });
    return;
  }
};
```

- [ ] **Step 4: Add the transport half**

In `src/pool.ts`, a deferred for the reply plus the method:

```ts
  let deferredClose: PromiseWithResolvers<void> | undefined;
```

in `onmessage`:

```ts
    if (callId === 0 && type === 'closed') {
      deferredClose?.resolve();
      return;
    }
```

and on the worker object:

```ts
    close: async () => {
      if (!deferredClose) {
        deferredClose = Promise.withResolvers<void>();
        worker.postMessage({ type: 'close', callId: 0 });
      }
      await deferredClose.promise;
    },
```

Add `close: () => Promise<void>` to the `PoolWorker` type alongside `query`, `interrupt`
and `quiesce`. The client bounds this call; the transport does not bound it twice.

- [ ] **Step 5: Add the client half**

In `src/client.ts`:

```ts
  /** Bounds any settlement that depends on a worker answering. */
  const bounded = async (promise: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let closing: Promise<void> | undefined;

  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      // Shutting the front door first: queued waiters reject at once and no new
      // work can be acquired while the in-flight work drains.
      const draining = scheduler.shutdown(
        new SQLiteError('CLIENT_CLOSED', 'The SQLite client has been closed.'),
      );
      // A transaction's lease is held by user code, so this wait is bounded like
      // the rest: a callback that never returns must not make close() hang.
      await bounded(draining, drainTimeout);
      await Promise.all(
        pool.map(async (worker) => {
          if (!worker) return;
          await bounded(worker.close(), drainTimeout);
          worker.terminate();
        }),
      );
      pool.length = 0;
    })();
    return closing;
  };
```

Update the `SQLiteDB.close` JSDoc: it now returns a promise, closes the database, settles in-flight work and rejects queued work — while still not deleting any OPFS file.

- [ ] **Step 6: Make both dispatches exhaustive**

Every message type now has a handler, so add the never-check that the cleanup list has been asking for. In `src/pool.ts`'s `onmessage`, after the last case of the `switch (type)`:

```ts
        default: {
          const unexpected: never = data;
          throw new Error(
            `Unhandled worker message: ${JSON.stringify(unexpected)}`,
          );
        }
```

and the same shape on `src/worker/worker.ts`'s two `self.onmessage` dispatches.

- [ ] **Step 7: Run the tests**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS. Existing suites calling `db.close()` without awaiting keep working — the promise is simply ignored.

- [ ] **Step 8: Commit**

```bash
git add src/client.ts src/pool.ts src/worker/worker.ts src/wa-sqlite.d.ts tests/browser/close.test.ts
git commit -m "feat(client): close() drains, closes the database, then terminates"
```

---

### Task 9: Strict read routing

**Files:**
- Modify: `src/utils.ts`, `src/client.ts`
- Test: `tests/browser/routing.test.ts` (extend)

**Interfaces:**
- Consumes: `SQLiteError` (Task 1).
- Produces: `assertReadable(sql: string, method: string): void` in `utils.ts` — throws `SQLiteError('NOT_A_READ_QUERY')` when `isReadQuery(sql)` is false.

- [ ] **Step 1: Write the failing tests**

Append to `tests/browser/routing.test.ts`:

```ts
describe('routing — strictness', () => {
  // Falsifiable: delete the assertReadable call at any one of the four sites
  // and the corresponding case silently runs the DELETE.
  it.each(['read', 'chunk', 'stream', 'first'] as const)(
    '%s() rejects a write statement',
    async (method) => {
      const db = await createTestClient({ poolSize: 1 });
      await db.write('CREATE TABLE t (a)');
      await db.write('INSERT INTO t (a) VALUES (1)');

      const call = async () => {
        const result = db[method]('DELETE FROM t');
        // chunk() and stream() are generators: the throw arrives on the first
        // next(), not at the call.
        if (Symbol.asyncIterator in Object(result)) {
          for await (const _ of result as AsyncGenerator<unknown>) break;
          return;
        }
        await result;
      };

      await expect(call()).rejects.toMatchObject({ code: 'NOT_A_READ_QUERY' });
      const rows = await db.read('SELECT * FROM t');
      expect(rows.length).toBe(1);
    },
  );

  // Falsifiable: put the ternary back on write()'s acquire.
  it('write() accepts a read statement and routes it to the writer', async () => {
    const db = await createTestClient({ poolSize: 2 });
    const { result } = await db.write<{ n: number }>('SELECT 1 AS n');
    expect(result[0]?.n).toBe(1);
  });

  // Documented regression, not an accident. B4 (wave 3) must give read pragmas
  // back to read(); when it does, this test turns red — that is the signal.
  it('rejects a read pragma on read(), which write() still accepts', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a)');
    await expect(db.read('PRAGMA table_info(t)')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    const { result } = await db.write('PRAGMA table_info(t)');
    expect(result.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `timeout -k 30 600 pnpm test:browser`
Expected: FAIL — the `DELETE` runs and the row count is 0.

- [ ] **Step 3: Implement**

In `src/utils.ts`:

```ts
import { SQLiteError } from './errors';

/**
 * Routing guard for the read-shaped methods. Throws before a lease is taken, so
 * a rejected statement costs no pool capacity.
 *
 * Note: `isReadQuery` classifies every PRAGMA as a write, so a read pragma has
 * to go through `write()` until B4 lands its pragma allowlist.
 */
export const assertReadable = (sql: string, method: string) => {
  if (isReadQuery(sql)) return;
  const keyword = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  throw new SQLiteError(
    'NOT_A_READ_QUERY',
    `${method}() only accepts statements that are provably reads; "${keyword}" must go through write(). ` +
      `Note that every PRAGMA is currently classified as a write.`,
  );
};
```

In `src/client.ts`, the four read-shaped methods open with the guard and acquire a read lease:

```ts
    assertReadable(sql, 'read');
    const lease = await scheduler.acquire('read');
```

and `write` loses its ternary:

```ts
    const lease = await scheduler.acquire('write');
```

- [ ] **Step 4: Sweep the regressions**

Run: `timeout -k 30 600 pnpm test` and fix every test that hands a write statement or a pragma to a read-shaped method. Expect hits in `tests/browser/queries.test.ts` and `tests/browser/vfs.test.ts`. Change the call to `write()`; do not weaken the guard.

- [ ] **Step 5: Run everything**

Run: `timeout -k 30 300 pnpm check && timeout -k 30 300 npx tsc --noEmit && timeout -k 30 600 pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils.ts src/client.ts tests/browser/
git commit -m "feat(routing)!: read-shaped methods reject a write statement"
```

---

### Task 10: Documentation and memories

**Files:**
- Modify: `README.md`, `src/client.ts` (JSDoc), `src/transaction.ts` (JSDoc)
- Modify: `.serena/memories/project-state.md`, `.serena/memories/follow-ups.md`, `.serena/memories/resume-plan.md`

- [ ] **Step 1: README**

Add an "Error handling" section documenting `SQLiteError` and its five codes, and a row per new option (`maxWorkerRestarts`, `openTimeout`, `drainTimeout`) in the options table. State plainly:

- a caller bounds a request with `AbortSignal.timeout()`; the library adds no per-request timeout;
- `close()` is now async;
- read-shaped methods reject a write statement, and every PRAGMA currently counts as a write.

- [ ] **Step 2: JSDoc**

- `SQLiteDB.close` — the new contract (§Task 8 Step 5).
- `SQLiteDB.chunk` / `stream` — the `NOT_A_READ_QUERY` throw arrives on the first `next()`.
- `transaction()` — a worker that dies mid-transaction rejects it, and releasing any OPFS file lock then depends on the browser reclaiming the terminated worker's handle.
- `first()` — unchanged wording; BP-1 still owns the hard bound.

- [ ] **Step 3: Memories**

- `project-state.md` — the two new modules with their line counts, the new options, the new public export (`SQLiteError`), `close()`'s new signature, and the new invariant: *the lease returns on quiesce, not on the caller's exit*.
- `follow-ups.md` — mark **B2** and **B3** done with their evidence; move **W-route** to done; add the obligation on **B4** (give read pragmas back to `read()`); record the residual limit from Step 4 below.
- `resume-plan.md` — a wave 2 entry in §4, and wave 3 named as next.

- [ ] **Step 4: Record the residual limit honestly**

A worker killed silently while a query is in flight is only noticed if the caller aborts:
nothing else is waiting on a timer at that moment, by design (§5.3 of the spec — no
liveness signal exists during a `step()`). Write this in `follow-ups.md` under B2's entry
as a known residual, and note that BP-1 (wave 4) removes it: a per-chunk ack is a
heartbeat, so silence becomes detectable without guessing.

- [ ] **Step 5: Commit**

```bash
git add README.md src/ .serena/memories/
git commit -m "docs(wave-2): error handling, the new options, and the memories"
```

---

## Definition of Done

1. `timeout -k 30 600 pnpm test` green, and **the suite exits on its own** — no worker handle keeps the process alive. This is the concrete signal that B2's hang is gone.
2. `timeout -k 30 300 npx tsc --noEmit` and `timeout -k 30 300 pnpm check` clean.
3. `timeout -k 30 900 pnpm test:consumer` green — the packaging gate still passes with the new export.
4. Every task's tests present and falsifiable, each with the comment naming the line that kills it.
5. Memories updated, git clean, branch `wave-2-error-surface` ready for the user's merge decision.
