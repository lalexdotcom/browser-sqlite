# Wave 4 — BP-1 back-pressure and D2 `SharedArrayBuffer` removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the worker wait for a client credit before sending each chunk, so chunk production is bounded and the worker returns to its event loop — then delete the `SharedArrayBuffer` and the cross-origin isolation requirement it imposes on every consuming application.

**Architecture:** A pure credit gate (`src/credits.ts`) owns two independent counters: credits, which bound how far the worker may run ahead, and a row counter, which forces an unconditional task turn every 1000 rows. The worker takes a credit before emitting each chunk; the client grants one credit per chunk **consumed**. Once the worker reliably returns to its event loop, `stop` becomes a message and the `SharedArrayBuffer` has no remaining purpose.

**Tech Stack:** TypeScript 7 (`tsc` via `pnpm exec tsc`), rslib 0.23.2, rstest 0.11.8 (two projects: `unit` in Node, `browser` in real Chromium via Playwright), biome 2.5.8, pnpm 10.31.0.

**Spec:** `docs/superpowers/specs/2026-08-19-wave-4-backpressure-design.md` — read it before starting. Every task argues from it.

**Branch:** `feat/wave-4-backpressure`, already created from `main` at `c07c92f`. Five probe commits are already on it; the source tree is identical to `main`'s.

## Global Constraints

- **Credit window: 2 by default; `first()` passes 1.** Spec §3.4, §4.1.
- **Row-counter tick: one task turn every 1000 rows stepped.** Spec §3.6. The plan may not remove this mechanism; only its constant is negotiable.
- **The tick uses `MessageChannel`, never `setTimeout`** — nested `setTimeout` is clamped to 4 ms, which costs seconds over a few hundred chunks. Spec §3.1.
- **Credits carry the `callId`; stale ones are ignored; the counter resets at query start.** Both are required, for two different leaks. Spec §5.4.
- **`stop` must wake a credit wait already in progress**, not merely be tested before it. Spec §5.1.
- **Credits are granted on consumption, never on arrival.** Spec §3.3.
- **No performance assertions in any test.** Spec §6.3.
- **Serena's symbolic tools are primary for code edits** (`AGENTS.md`); built-in Read/Edit only for Markdown, JSON and config.
- **After every modification:** `pnpm check`, then `pnpm exec tsc --noEmit`, then `pnpm test`. All 272 existing tests must stay green at every commit.
- **rstest 0.11.8 has no `it.each`** — parameterized tests use a plain `for` loop calling `it()`.
- Commit messages: conventional prefix, and end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/credits.ts` *(create)* | The pure credit gate and the `MessageChannel` tick factory. No DOM beyond `MessageChannel`, no worker, no SQLite — drivable from Node in milliseconds. |
| `tests/unit/credits.test.ts` *(create)* | Node tests for the gate's state transitions. |
| `tests/browser/backpressure.test.ts` *(create)* | The properties only a real worker can show: no pile-up, no worker restart on abort, `first()`, `close()` mid-query, filtering scan. |
| `src/types.ts` *(modify)* | Wire protocol: `credits` in query options, `credit` and `stop` client messages. |
| `src/worker/worker.ts` *(modify)* | Takes a credit before each chunk; ticks on the row counter; handles `credit` and `stop`; later loses the orchestrator. |
| `src/pool.ts` *(modify)* | Sends the window, grants a credit after each `yield`, posts `stop` in the drain; later owns the worker status field. |
| `src/queries.ts` *(modify)* | Threads `credits` through `chunk()`; `firstWorker` passes 1. |
| `src/client.ts` *(modify)* | Loses the orchestrator; debug wiring updated. |
| `src/debug.ts` *(modify)* | Reads worker status from the pool instead of the `SharedArrayBuffer`. |
| `src/locks.ts` *(modify)* | Gains `initLockName`. |
| `src/orchestrator.ts` *(delete)* | 183 lines, no remaining purpose after Task 7. |
| `rstest.config.ts`, `scripts/static-server.mjs`, `tests/consumer/vite.config.ts`, `tests/consumer-rsbuild/rsbuild.config.ts`, `README.md` *(modify)* | Drop the COOP/COEP requirement. |

**Phase order (spec §4.4):** Tasks 1-4 are BP-1; Tasks 5-8 are D2. BP-1 does not need the `SharedArrayBuffer` gone; D2 needs BP-1. The two abort mechanisms coexist between Task 2 and Task 7, deliberately, so a bisect stays meaningful.

---

## Task 1: The pure credit gate

**Files:**
- Create: `src/credits.ts`
- Test: `tests/unit/credits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Tick = () => Promise<void>`; `createMessageChannelTick(): Tick`; `createCreditGate(tick: Tick, rowsPerTick?: number): CreditGate`; `ROWS_PER_TICK = 1000`. `CreditGate` has `reset(callId: number, window: number): void`, `grant(callId: number, n: number): void`, `stop(): void`, `take(callId: number): Promise<'go' | 'stopped'>`, `countRow(): boolean`, `isStopped(): boolean`, `tick: Tick`. `isStopped` is unused until Task 7; it is defined here because the gate owns the flag.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/credits.test.ts`:

```typescript
import { describe, expect, it } from '@rstest/core';
import { createCreditGate, type Tick } from '../../src/credits';

/** A tick that resolves immediately but is still awaited, and counts calls. */
const countingTick = () => {
  let calls = 0;
  const tick: Tick = async () => {
    calls += 1;
  };
  return { tick, calls: () => calls };
};

describe('createCreditGate', () => {
  it('lets the window through without any grant', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 2);
    expect(await gate.take(1)).toBe('go');
    expect(await gate.take(1)).toBe('go');
  });

  it('blocks once the window is spent, and resumes on a grant', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 1);
    expect(await gate.take(1)).toBe('go');

    let settled = false;
    const pending = gate.take(1).then((outcome) => {
      settled = true;
      return outcome;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.grant(1, 1);
    expect(await pending).toBe('go');
  });

  // Falsifiable: drop `wake()` from stop(), or drop `&& !stopped` from the
  // wait condition, and this hangs until the test times out. This is §5.1,
  // the failure that would restart a healthy worker on every first() call.
  it('wakes a wait already in progress when stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 0);
    const pending = gate.take(1);
    gate.stop();
    expect(await pending).toBe('stopped');
  });

  it('returns stopped without waiting once stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 5);
    gate.stop();
    expect(await gate.take(1)).toBe('stopped');
    expect(gate.isStopped()).toBe(true);
  });

  // Falsifiable: remove the callId guard in grant() and this passes a credit
  // from an abandoned query into the current one — §5.4's late arrival.
  it('ignores a grant addressed to another query', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(2, 0);
    gate.grant(1, 5);
    let settled = false;
    void gate.take(2).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  // Falsifiable: make reset() keep the counter and this lets a credit granted
  // for the previous query buy a chunk in the next — §5.4's unspent leftover.
  it('clears unspent credits on reset', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(1, 0);
    gate.grant(1, 5);
    gate.reset(2, 1);
    expect(await gate.take(2)).toBe('go');
    let settled = false;
    void gate.take(2).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('treats a take for a superseded query as stopped', async () => {
    const gate = createCreditGate(countingTick().tick);
    gate.reset(2, 5);
    expect(await gate.take(1)).toBe('stopped');
  });

  // THE load-bearing test. Falsifiable: skip the tick when credits are
  // available — the obvious "optimisation" — and the count drops below the
  // number of takes. The measurement in spec §2.2 showed that without a task
  // turn per chunk, a mid-query abort is delivered as late as the batch size.
  it('awaits the tick on every take, even when credits are available', async () => {
    const counter = countingTick();
    const gate = createCreditGate(counter.tick);
    gate.reset(1, 3);
    await gate.take(1);
    await gate.take(1);
    await gate.take(1);
    expect(counter.calls()).toBe(3);
  });

  it('signals a row tick every rowsPerTick rows and not before', () => {
    const gate = createCreditGate(countingTick().tick, 3);
    expect(gate.countRow()).toBe(false);
    expect(gate.countRow()).toBe(false);
    expect(gate.countRow()).toBe(true);
    expect(gate.countRow()).toBe(false);
  });

  it('restarts the row count on reset', () => {
    const gate = createCreditGate(countingTick().tick, 3);
    gate.countRow();
    gate.countRow();
    gate.reset(1, 1);
    expect(gate.countRow()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test:unit credits`
Expected: FAIL — `Cannot find module '../../src/credits'`.

- [ ] **Step 3: Write the implementation**

Create `src/credits.ts`:

```typescript
/**
 * The credit gate: back-pressure for chunk production, and the task turn that
 * makes a worker reachable by `postMessage` while it is inside a query.
 *
 * Two counters, deliberately independent (spec §2.3, §3.6):
 *  - credits bound how far ahead of the consumer the worker may run;
 *  - the row counter forces a task turn even when no chunk is produced, which
 *    is what keeps a filtering scan interruptible.
 *
 * Pure and Node-testable on purpose. B1 survived for months because the
 * scheduler was reachable only through slow browser tests; this module has the
 * same profile — subtle state transitions otherwise buried behind a worker, a
 * VFS and a real database.
 */

/** One turn of the task queue. Injected so Node tests can drive it. */
export type Tick = () => Promise<void>;

export const ROWS_PER_TICK = 1000;

export type CreditGate = {
  /** Begin a query: `window` credits, not stopped, both counters cleared. */
  reset: (callId: number, window: number) => void;
  /** Add credits for `callId`. A stale `callId` is ignored (§5.4). */
  grant: (callId: number, n: number) => void;
  /** Stop the current query, waking any wait in progress (§5.1). */
  stop: () => void;
  /** Spend one credit. Always costs one task turn first. */
  take: (callId: number) => Promise<'go' | 'stopped'>;
  /** Count a stepped row; true when a task turn is due. */
  countRow: () => boolean;
  isStopped: () => boolean;
  tick: Tick;
};

/**
 * A task turn via MessageChannel. NOT setTimeout: nested setTimeout is clamped
 * to 4 ms, which would cost seconds over a few hundred chunks (spec §3.1).
 */
export const createMessageChannelTick = (): Tick => {
  const channel = new MessageChannel();
  const waiters: (() => void)[] = [];
  channel.port1.onmessage = () => {
    waiters.shift()?.();
  };
  return () =>
    new Promise<void>((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(0);
    });
};

export const createCreditGate = (
  tick: Tick,
  rowsPerTick: number = ROWS_PER_TICK,
): CreditGate => {
  let credits = 0;
  let currentCallId = -1;
  let stopped = false;
  let rows = 0;
  let signal = Promise.withResolvers<void>();

  /** Settle whoever is waiting, and arm a fresh signal for the next wait. */
  const wake = () => {
    const previous = signal;
    signal = Promise.withResolvers<void>();
    previous.resolve();
  };

  return {
    reset: (callId, window) => {
      currentCallId = callId;
      credits = window;
      stopped = false;
      rows = 0;
    },

    grant: (callId, n) => {
      if (callId !== currentCallId) return;
      credits += n;
      wake();
    },

    stop: () => {
      stopped = true;
      wake();
    },

    take: async (callId) => {
      if (callId !== currentCallId) return 'stopped';
      // Unconditional, before the credit check: this is the task turn, and it
      // is the only reason a queued `stop` or `close` is ever delivered.
      await tick();
      while (credits <= 0 && !stopped) {
        await signal.promise;
      }
      if (stopped) return 'stopped';
      credits -= 1;
      return 'go';
    },

    countRow: () => {
      rows += 1;
      if (rows >= rowsPerTick) {
        rows = 0;
        return true;
      }
      return false;
    },

    isStopped: () => stopped,
    tick,
  };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test:unit credits`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the whole suite and the types**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 282 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/credits.ts tests/unit/credits.test.ts
git commit -m "$(cat <<'EOF'
feat(credits): the pure credit gate, with its task turn

Two independent counters: credits bound how far the worker may run ahead
of the consumer, and a row counter forces a task turn every 1000 rows
even when no chunk is produced.

Pure and driven from Node, for the reason wave 1 established: B1 survived
because the scheduler was reachable only through slow browser tests.

The load-bearing test asserts a tick on every take, including when
credits are available. Skipping it is the obvious optimisation, and the
measurement in the spec's §2.2 shows what it costs: a mid-query abort
delivered as late as the credit batch.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire the gate through the protocol

Worker and client together. They cannot be split: a worker that waits for credits nobody sends hangs the entire suite.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker/worker.ts`
- Modify: `src/pool.ts`
- Test: `tests/browser/backpressure.test.ts` (create)

**Interfaces:**
- Consumes: `createCreditGate`, `createMessageChannelTick` from Task 1.
- Produces: client message `{ type: 'credit'; callId: number; n: number }` and `{ type: 'stop'; callId: number }`; query option `credits?: number`; `PoolWorkerQueryOptions.credits?: number`; `CREDIT_WINDOW = 2` exported from `src/pool.ts`.

- [ ] **Step 1: Extend the wire protocol**

In `src/types.ts`, change the `SQLOptions` type to:

```typescript
type SQLOptions = {
  chunkSize?: number;
  /** Chunks the worker may send before waiting for a credit. Spec §3.2. */
  credits?: number;
};
```

and add two variants to `ClientMessageData`, after the `close` variant:

```typescript
  | { type: 'credit'; callId: number; n: number }
  | { type: 'stop'; callId: number };
```

- [ ] **Step 2: Take a credit before each chunk, and tick on rows**

In `src/worker/worker.ts`, add to the imports:

```typescript
import { createCreditGate, createMessageChannelTick } from '../credits';
```

Add beside the other module-level state (next to `let openedDB`):

```typescript
const gate = createCreditGate(createMessageChannelTick());
```

In the `query` generator's row loop, immediately after the `SQLITE_ROW` branch pushes a row, add the row tick — it must run whether or not a chunk is produced:

```typescript
          buffer.push(rowObject);
          // Spec §3.6: a filtering scan produces no chunk for millions of
          // rows. Without this the worker never returns to its event loop and
          // a stop cannot reach it.
          if (gate.countRow()) await gate.tick();
```

In the post-open `self.onmessage` handler, in `case 'query'`, immediately after `orchestrator.setStatus(index, WorkerStatuses.RUNNING);`:

```typescript
          gate.reset(callId, options?.credits ?? 2);
```

and replace the body of the `for await` loop with:

```typescript
          for await (const chunk of query(sql, params, options)) {
            if (typeof chunk === 'number') {
              affected = chunk;
              break;
            }
            if ((await gate.take(callId)) === 'stopped') break;
            reply({ type: 'chunk', callId, data: chunk });
          }
```

Add two cases to the same handler, before `default`:

```typescript
      case 'credit': {
        gate.grant(data.callId, data.n);
        break;
      }
      case 'stop': {
        gate.stop();
        break;
      }
```

Add the same two cases to the **pre-open** `self.onmessage` at the bottom of the file, so the exhaustive `never` check still holds:

```typescript
    // No query can be running before open.
    case 'credit':
    case 'stop': {
      break;
    }
```

- [ ] **Step 3: Grant credits on consumption, and post stop in the drain**

In `src/pool.ts`, add the window constant next to `const STOP = Symbol('stop');`:

```typescript
/** Chunks the worker may run ahead of the consumer. Spec §3.4. */
export const CREDIT_WINDOW = 2;
```

Add `credits` to `PoolWorkerQueryOptions`:

```typescript
export type PoolWorkerQueryOptions = {
  id?: string;
  chunkSize?: number;
  credits?: number;
  debug?: string;
};
```

In the `query` generator, destructure the window and send it:

```typescript
      const { chunkSize = 500, credits = CREDIT_WINDOW } = options ?? {};
```

```typescript
      worker.postMessage({
        type: 'query',
        callId: ++currentCallId,
        sql,
        params,
        options: { chunkSize, credits },
      });
```

Replace the streaming loop with one that credits **after** the `yield`:

```typescript
      // Stream chunks until query completes
      while (deferredChunk) {
        const chunk = await Promise.race([
          deferredChunk.promise,
          stopRequested.promise,
          lost.promise,
          deathDeferred.promise,
        ]);
        if (chunk === STOP) break;
        yield chunk as T[] | number;
        // Spec §3.3: the credit is issued once the CONSUMER has taken the
        // chunk. Crediting on arrival would let the worker run at full speed
        // and pile the chunks up in the message queue, which is the guarantee
        // this whole mechanism exists to make true.
        if (typeof chunk !== 'number') {
          worker.postMessage({ type: 'credit', callId: currentCallId, n: 1 });
        }
      }
```

In the generator's `finally`, post the stop alongside the existing flag write:

```typescript
      if (deferredChunk && !dead) {
        orchestrator.setStatus(
          index,
          WorkerStatuses.ABORTING,
          WorkerStatuses.RUNNING,
        );
        // Spec §5.1: the worker may be parked waiting for a credit that this
        // unwinding client will never send. The flag above cannot reach it
        // there — only a message can.
        worker.postMessage({ type: 'stop', callId: currentCallId });
```

- [ ] **Step 4: Write the browser tests**

Create `tests/browser/backpressure.test.ts`:

```typescript
import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

/** 5000 rows, one column — enough chunks that running ahead is obvious. */
const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await db.write(
    `INSERT INTO t(id) SELECT x FROM (
       WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 5000)
       SELECT x FROM c)`,
  );
};

const chunksPosted = (record: { received: string[] }) =>
  record.received.filter((type) => type === 'chunk').length;

describe('back-pressure', () => {
  // Falsifiable: grant the credit when the chunk message arrives instead of
  // after the yield, or drop the credit wait in the worker, and the worker
  // posts all 5000 chunks while this consumer sleeps. Pins spec §3.3.
  it('does not let the worker run ahead of a slow consumer', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    await seed(db);

    let seen = 0;
    for await (const _rows of db.chunk('SELECT id FROM t', [], {
      chunkSize: 1,
    })) {
      seen += 1;
      if (seen === 5) {
        await sleep(300);
        break;
      }
    }

    // Five consumed, plus at most one window of look-ahead.
    expect(chunksPosted(records[0])).toBeLessThanOrEqual(7);
  });

  // Falsifiable: remove the `stop` message from pool.ts's drain, or the wake
  // from the gate's stop(), and the worker stays parked on a credit until
  // drainTimeout, is presumed dead, and is replaced. Pins spec §5.1.
  it('does not restart the worker when a stream is abandoned', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 1000 });
    await seed(db);

    for await (const _rows of db.chunk('SELECT id FROM t', [], {
      chunkSize: 1,
    })) {
      break;
    }

    await sleep(1500); // past drainTimeout, plus a replacement's boot
    expect(records.length).toBe(1);

    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
  });

  // Spec §5.2. The client-side race already carries deathDeferred, and the new
  // wait is worker-side, so this should be unaffected — but the worker is now
  // parked rather than stepping when it dies, which is a state that did not
  // exist before. Falsifiable: drop deathDeferred from the race in pool.ts's
  // generator and the abandoned read never settles.
  it('reclaims a worker killed while it is parked on a credit', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await seed(db);

    const streaming = (async () => {
      for await (const _rows of db.chunk('SELECT id FROM t', [], {
        chunkSize: 1,
      })) {
        await sleep(50); // long enough that the worker is waiting, not working
      }
    })();

    await sleep(200);
    records[0].worker.terminate(); // silent death: no event of any kind

    await expect(streaming).rejects.toThrow();
    await sleep(1500);
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2); // the dead one was replaced
  });

  it('still delivers every row when the consumer keeps up', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await seed(db);
    const rows = await db.read<{ id: number }>('SELECT id FROM t');
    expect(rows).toHaveLength(5000);
    expect(rows[4999]?.id).toBe(5000);
  });
});
```

- [ ] **Step 5: Run the new tests**

Run: `pnpm test:browser backpressure`
Expected: PASS, 4 tests.

**Note on spec §5.5.** It asks that per-slot credit bookkeeping be reset when a
slot is replaced. This implementation has none to reset: the client sends the
window inside the `query` message and grants one credit per consumed chunk, so
all credit state lives in the worker, and a replacement worker is a fresh
`Worker` with a fresh gate. Nothing to do — but do not read that as the concern
being dismissed. If a later change gives the client its own credit counter, §5.5
comes back.

- [ ] **Step 6: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 286 tests, 0 failures. If any existing abort or streaming test hangs, the cause is a worker parked on a credit — check Step 3's `stop` message before anything else.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/worker/worker.ts src/pool.ts tests/browser/backpressure.test.ts
git commit -m "$(cat <<'EOF'
feat(pool): back-pressure — a credit per chunk, granted on consumption

The worker takes a credit before sending each chunk and ticks every 1000
rows stepped; the client grants one credit after the consumer has taken a
chunk, never on arrival. The drain now posts a stop message as well as
setting the abort flag: a worker parked on a credit cannot see the flag,
and only a message reaches it there.

Both abort mechanisms coexist from here until the SharedArrayBuffer is
removed, deliberately, so a bisect stays meaningful.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `first()` takes exactly one row

**Files:**
- Modify: `src/queries.ts`
- Test: `tests/browser/backpressure.test.ts:appended`

**Interfaces:**
- Consumes: `PoolWorkerQueryOptions.credits` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/backpressure.test.ts`:

```typescript
describe('first()', () => {
  // Falsifiable two ways. Drop `credits: 1` and the worker produces a second
  // row nobody asked for, so chunksPosted becomes 2. Break the stop-wakes-the
  // -wait path and each call parks its worker until drainTimeout, so it is
  // replaced and records.length grows. Pins spec §4.1 and §5.1.
  it('costs exactly one row, and never restarts its worker', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 1000 });
    await seed(db);

    for (let call = 0; call < 10; call += 1) {
      const row = await db.first<{ id: number }>('SELECT id FROM t');
      expect(row?.id).toBe(1);
    }

    expect(chunksPosted(records[0])).toBe(10);
    await sleep(1500);
    expect(records.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:browser backpressure`
Expected: FAIL on `expect(chunksPosted(records[0])).toBe(10)` — it will be 20, because the default window of 2 lets the worker produce a second row per call.

- [ ] **Step 3: Pass a window of 1 from `first()`**

In `src/queries.ts`, add `credits` to `chunk`'s options and forward it:

```typescript
  options?: { chunkSize?: number; signal?: AbortSignal; credits?: number },
): AsyncGenerator<T[]> {
  const { signal, chunkSize, credits } = options ?? {};
```

```typescript
  const iterator = worker.query<T>(sql, params, { chunkSize, credits });
```

Then, in `firstWorker`, request a single row and a single credit:

```typescript
  for await (const rows of chunk<T>(worker, sql, params, {
    ...options,
    chunkSize: 1,
    // Spec §4.1: with the default window of 2 the worker would produce a
    // second row before parking. One credit is the exact one-row bound the
    // JSDoc has always promised.
    credits: 1,
  })) {
    return rows[0];
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:browser backpressure`
Expected: PASS, 5 tests.

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 287 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/queries.ts tests/browser/backpressure.test.ts
git commit -m "$(cat <<'EOF'
feat(queries): first() takes one row, and only one

chunkSize was already 1; the default credit window of 2 still let the
worker produce a second row before parking. One credit makes the bound
exact — the one its JSDoc has always promised.

The test also pins that ten calls leave one worker alive: first() parks
its worker on a credit nobody will send, so it exercises the stop path on
every single call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `close()` during a query stops before it closes

**Files:**
- Modify: `src/worker/worker.ts`
- Test: `tests/browser/backpressure.test.ts:appended`

**Interfaces:**
- Consumes: the gate's `stop()` from Task 1, the tick from Task 2.
- Produces: nothing new.

Spec §5.3. Until Task 2, a worker inside its row loop never received `close`. Now it can — and the current handler calls `sqlite.close(db)` straight away, which with a live statement returns `SQLITE_BUSY`, is swallowed by the existing `catch`, and replies `closed` while the loop still runs.

- [ ] **Step 1: Write the failing test**

Append to `tests/browser/backpressure.test.ts`:

```typescript
describe('close() during a query', () => {
  // Falsifiable: revert the close handler to closing immediately and the
  // worker replies `closed` while its loop still runs, so the read below
  // resolves with rows after close() promised the connection was shut.
  // Pins spec §5.3.
  it('stops the query first, then closes', async () => {
    const db = await createTestClient({ poolSize: 1, drainTimeout: 2000 });
    await seed(db);

    const streaming = (async () => {
      const collected: number[] = [];
      for await (const rows of db.chunk<{ id: number }>(
        'SELECT id FROM t',
        [],
        { chunkSize: 1 },
      )) {
        collected.push(rows[0]?.id ?? -1);
        await sleep(5);
      }
      return collected;
    })().catch(() => 'rejected' as const);

    await sleep(100);
    const started = performance.now();
    await db.close();
    // Bounded by drainTimeout; if the stop never reached the worker this
    // would sit on the timeout instead.
    expect(performance.now() - started).toBeLessThan(2000);

    await streaming;
    await expect(db.read('SELECT 1 AS n')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:browser backpressure`
Expected: FAIL — `close()` takes the full `drainTimeout`, or the worker replies `closed` while stepping.

- [ ] **Step 3: Stop before closing**

In `src/worker/worker.ts`, in the post-open handler, replace `case 'close'` with:

```typescript
      case 'close': {
        // Spec §5.3: with the tick, `close` is deliverable mid-query for the
        // first time. Closing a database under a live statement returns
        // SQLITE_BUSY, which the catch below would swallow while the row loop
        // kept running. Stop first, let the query unwind, then close.
        gate.stop();
        await idleUntilQueryEnds();
        try {
          const { sqlite, db } = await openedDB!;
          await sqlite.close(db);
        } catch {
          // A database that never opened has nothing to close; the client is
          // shutting down either way and must still get its reply.
        }
        reply({ type: 'closed', callId: 0 });
        break;
      }
```

Add the query-in-flight tracker beside the gate, at module level in `src/worker/worker.ts`:

```typescript
/** Resolved while no query is running; `close` waits on it before closing. */
let queryRunning: PromiseWithResolvers<void> | undefined;
const idleUntilQueryEnds = () => queryRunning?.promise ?? Promise.resolve();
```

In `case 'query'`, arm it beside the `gate.reset` call:

```typescript
          gate.reset(callId, options?.credits ?? 2);
          queryRunning = Promise.withResolvers<void>();
```

and settle it in the same `finally` that already resets the worker status:

```typescript
          orchestrator.setStatus(index, WorkerStatuses.DONE);
          queryRunning?.resolve();
          queryRunning = undefined;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test:browser backpressure`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 288 tests, 0 failures. `tests/browser/close.test.ts` is the one to watch — it owns the wave-2 close handshake.

- [ ] **Step 6: Commit**

```bash
git add src/worker/worker.ts tests/browser/backpressure.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): close stops the query before closing the database

Back-pressure made `close` deliverable mid-query for the first time, and
the handler was written for a world where that could not happen: it
called sqlite.close() straight away, which under a live statement returns
SQLITE_BUSY, was swallowed by the catch, and replied `closed` while the
row loop kept running.

It now stops, waits for the query to unwind, then closes. Same mechanism
as the drain, reused.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: The init mutex moves to `navigator.locks`

First task of D2. From here the `SharedArrayBuffer` loses its uses one at a time.

**Files:**
- Modify: `src/locks.ts`
- Modify: `src/worker/worker.ts`

**Interfaces:**
- Consumes: `createLocks` from `src/locks.ts`.
- Produces: `initLockName(file: string): string`.

- [ ] **Step 1: Add the lock name and its test**

In `src/locks.ts`, beside `sweepLockName`:

```typescript
/** Serializes database opening across the pool — replaces the SAB init mutex. */
export const initLockName = (file: string) => `bsq:init:${file}`;
```

Append to `tests/unit/locks.test.ts`:

```typescript
describe('initLockName', () => {
  it('is distinct per database file', () => {
    expect(initLockName('a.db')).not.toBe(initLockName('b.db'));
  });

  it('does not collide with the sweep or staging namespaces', () => {
    expect(initLockName('a.db')).not.toBe(sweepLockName('a.db'));
    expect(initLockName('a.db').startsWith('bsq:init:')).toBe(true);
  });
});
```

Add `initLockName` to that file's import list.

- [ ] **Step 2: Run it**

Run: `pnpm test:unit locks`
Expected: PASS.

- [ ] **Step 3: Hold the lock across open and pragmas**

In `src/worker/worker.ts`, add to the imports:

```typescript
import { createLocks, initLockName } from '../locks';
```

and beside the gate:

```typescript
const locks = createLocks();
```

Replace the `.then()` that calls `orchestrator.lock()` and the `.then()` that unlocks with a single `withLock` covering open **and** the pragmas. The chain becomes:

```typescript
    .then(({ sqlite, module, vfsModule }) => {
      return (
        vfsModule.create(vfs, module, { lockPolicy: 'shared' }) as Promise<any>
      ).then((vfsInstance: any) => {
        sqlite.vfs_register(vfsInstance, true);
        // One lock for open + pragmas. withLock releases on throw too, which
        // is what the explicit unlock() in the old .catch existed to do.
        return locks.withLock(initLockName(file), async () => {
          const db = await sqlite.open_v2(file);
          for (const statement of renderPragmas(pragmas)) {
            for await (const stmt of sqlite.statements(db, statement)) {
              while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
            }
          }
          return { sqlite, db };
        });
      });
    })
    .then((opened) => {
      orchestrator.setStatus(index, WorkerStatuses.READY);
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
    .catch((error: unknown) => {
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message:
          error instanceof Error ? error.message : `Failed to open ${file}`,
        cause: cloneable(error),
      });
      throw error;
    });
```

Both `orchestrator.lock()` and both `orchestrator.unlock()` calls are gone. `setStatus(READY)` stays for now — Task 6 removes it.

Note for the implementer: `createLocks()` falls back to `noOpLocks` when the Web Locks API is absent, which would let the pool open concurrently. Every browser that ships OPFS also ships Web Locks, and Node 24 has it too; the degradation branch is the same one `locks.ts` already documents as unreachable in practice. Do not add a guard.

- [ ] **Step 4: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 290 tests, 0 failures. `tests/browser/init.test.ts` is the relevant one — it exercises pool start-up.

- [ ] **Step 5: Commit**

```bash
git add src/locks.ts src/worker/worker.ts tests/unit/locks.test.ts
git commit -m "$(cat <<'EOF'
refactor(worker): the init mutex moves to navigator.locks

First of the SharedArrayBuffer's two uses to go. One withLock now covers
open plus the pragmas, and releases on throw — which is what the explicit
unlock() in the old catch existed to do.

The primitive has been in locks.ts since wave 3; this is the reuse D2
always assumed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Worker status moves off the `SharedArrayBuffer`

**Files:**
- Modify: `src/pool.ts`
- Modify: `src/debug.ts`
- Modify: `src/client.ts`
- Modify: `src/worker/worker.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `PoolWorker.status: string`, maintained by `src/pool.ts`. `createClientDebug`'s second parameter changes from `orchestrator: WorkerOrchestrator` to `pool: (PoolWorker | undefined)[]`.

The client already knows every transition better than the `SharedArrayBuffer` does: it posts the query, receives `done`, and calls `interrupt`.

- [ ] **Step 1: Give `PoolWorker` a status field**

In `src/pool.ts`, add to the `PoolWorker` type:

```typescript
  /** Lifecycle label for the debug surface. Replaces the SAB status byte. */
  status: string;
```

Initialise it in the `Object.assign` that creates the worker:

```typescript
    { index, status: 'NEW' },
```

Set it at each transition already handled in this file:
- in the `ready` case of `worker.onmessage`, beside `ready = true;` → `worker.status = 'READY';`
- in `die()`, at the top → `worker.status = 'DEAD';`
- in the `query` generator, right after the `postMessage` that sends the query → `worker.status = 'RUNNING';`
- in the generator's `finally`, beside `worker.postMessage({ type: 'stop', ... })` → `worker.status = 'ABORTING';`
- at the end of that same `finally`, beside `idle?.resolve();` → `worker.status = dead ? 'DEAD' : 'READY';`
- in the `closed` case → `worker.status = 'CLOSED';`

- [ ] **Step 2: Read the status from the pool in debug**

In `src/debug.ts`, remove the `orchestrator` import and `statusToLabel`'s dependency on it. Change the signature:

```typescript
export const createClientDebug = (
  file: string,
  pool: (PoolWorker | undefined)[],
```

adding `import type { PoolWorker } from './pool';`.

Replace both status reads:

```typescript
        status: pool[index]?.status ?? 'EMPTY',
```

```typescript
          if (prop === 'status') {
            return pool[index]?.status ?? 'EMPTY';
          }
```

Delete `statusToLabel` and its `WorkerStatuses` import if nothing else uses them — check with `grep -rn "statusToLabel" src/ tests/` and delete the unit test cases that cover it if the function goes.

- [ ] **Step 3: Update the call site and drop the worker's status writes**

In `src/client.ts`, pass `pool` instead of `orchestrator` to `createClientDebug`, and delete the `onIdle` callback that set `READY`:

```typescript
  const scheduler = createScheduler<PoolWorker>();
```

`createScheduler`'s options parameter already defaults to `{}` and `onIdle` is already optional (`src/scheduler.ts:52-54`), so nothing else changes there.

In `src/worker/worker.ts`, delete all three `orchestrator.setStatus` calls (`READY` after open, `RUNNING` at query start, `DONE` in the finally). Keep `queryRunning?.resolve()` in that finally.

- [ ] **Step 4: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 0 failures. The total may drop below 290 if you deleted `statusToLabel`'s unit cases — that is expected; what must not change is the failure count. `tests/browser/debug.test.ts` and `tests/unit/debug.test.ts` are the ones to watch; update any assertion that expected an orchestrator label such as `INITIALIZED` or `DONE` — the new vocabulary is `NEW` / `READY` / `RUNNING` / `ABORTING` / `CLOSED` / `DEAD`.

- [ ] **Step 5: Commit**

```bash
git add src/pool.ts src/debug.ts src/client.ts src/worker/worker.ts
git commit -m "$(cat <<'EOF'
refactor(debug): worker status comes from the pool, not shared memory

The pool already knew every transition better than the status byte did —
it posts the query, receives done, and calls interrupt. Reading it from
there also retires the Proxy indirection the debug state needed to keep
the byte from going stale.

Second of the SharedArrayBuffer's uses to go.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: The abort becomes a message, and `orchestrator.ts` is deleted

**Files:**
- Modify: `src/worker/worker.ts`
- Modify: `src/pool.ts`
- Modify: `src/client.ts`
- Modify: `src/types.ts`
- Delete: `src/orchestrator.ts`
- Test: `tests/browser/backpressure.test.ts:appended`

**Interfaces:**
- Consumes: `gate.isStopped()` from Task 1, the `stop` message from Task 2.
- Produces: `ClientMessageData`'s `open` variant loses its `flags` field.

- [ ] **Step 1: Write the failing test**

This test could not fail before now: while the abort flag still lived in shared memory, the row loop saw it whatever the tick did. It becomes falsifiable only once the flag is gone, which is why it lands here and not in Task 2.

Append to `tests/browser/backpressure.test.ts`:

```typescript
describe('a scan that yields no rows', () => {
  // Falsifiable: remove the `if (gate.countRow()) await gate.tick()` from the
  // worker's row loop. The scan then produces no chunk, so no task turn, so
  // the stop message is never delivered: the drain expires, a healthy worker
  // is presumed dead, and records.length becomes 2. Pins spec §3.6.
  it('is still interruptible, and its worker survives', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 1000 });
    await db.write('CREATE TABLE big (id INTEGER PRIMARY KEY, data TEXT)');
    await db.write(
      `INSERT INTO big(data) SELECT hex(randomblob(16)) FROM (
         WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 200000)
         SELECT x FROM c)`,
    );

    await expect(
      db.read("SELECT * FROM big WHERE data = 'no-such-value'", [], {
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();

    await sleep(1500); // past drainTimeout, plus a replacement's boot
    expect(records.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run it — it passes, and that is the point**

Run: `pnpm test:browser backpressure`
Expected: PASS. The shared-memory flag is still in place, so the scan aborts through it. Record this: the test only becomes load-bearing after Step 3. Verify the falsifiability claim after Step 4 instead.

- [ ] **Step 3: Replace the flag with the gate's stop**

In `src/worker/worker.ts`, in the `query` generator's row loop, replace both orchestrator reads:

```typescript
        if (gate.isStopped()) break;

        const result = await sqlite.step(stmt);
        if (gate.isStopped()) break;
```

Delete the `orchestrator` variable, the `WorkerOrchestrator` import, and the `flags` parameter of `open()` — its signature becomes `(file, index, options?)`.

In `src/types.ts`, remove `flags: SharedArrayBuffer;` from the `open` variant of `ClientMessageData`.

In `src/pool.ts`, delete the `orchestrator` dep, the `WorkerOrchestrator`/`WorkerStatuses` import, the `setStatus(ABORTING)` call in the generator's `finally` (the `stop` message posted beside it already does the work), and `flags: orchestrator.sharedArrayBuffer` from the `open` message.

In `src/client.ts`, delete the `WorkerOrchestrator` import, the `orchestrator` construction, and the `orchestrator` argument passed to `createPoolWorker`.

- [ ] **Step 4: Delete the orchestrator and verify the test is falsifiable**

```bash
git rm src/orchestrator.ts
grep -rn "orchestrator\|SharedArrayBuffer\|WorkerStatuses" src/ tests/unit tests/browser
```
Expected: no hits in `src/`. Delete `tests/unit/orchestrator.test.ts` if one exists.

Now prove the new test can fail: comment out `if (gate.countRow()) await gate.tick();` in the worker's row loop, run `pnpm test:browser backpressure`, and confirm the scan test fails on `records.length`. Restore the line and confirm it passes again.

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test`
Expected: 291 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(worker): the abort is a message, and the orchestrator is gone

The row loop reads the gate's stopped flag, set by the stop message that
the drain has been posting since back-pressure landed. With the init
mutex on navigator.locks and the status on the pool, nothing is left in
shared memory, so orchestrator.ts goes — 183 lines.

The filtering-scan test becomes load-bearing exactly here: while the flag
lived in shared memory the row loop saw it whatever the tick did, so the
test could not fail. Its falsifiability was verified by commenting out
the row-counter tick and watching the worker be presumed dead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Drop the cross-origin isolation requirement

The payoff, and D2's acceptance test (spec §4.3): a demonstration, not an assertion.

**Files:**
- Modify: `rstest.config.ts`
- Modify: `scripts/static-server.mjs:29-30`
- Modify: `tests/consumer/vite.config.ts:8-9`
- Modify: `tests/consumer-rsbuild/rsbuild.config.ts:7-8`
- Modify: `README.md:210-250`

**Interfaces:**
- Consumes: Task 7's deletion of the `SharedArrayBuffer`.
- Produces: nothing.

- [ ] **Step 1: Remove the headers from the test server and both consumer apps**

Delete the two `res.setHeader('Cross-Origin-*', …)` lines in `scripts/static-server.mjs`, and the two-entry header objects in `tests/consumer/vite.config.ts` and `tests/consumer-rsbuild/rsbuild.config.ts` along with the config keys that carried them. Also delete any `crossOriginIsolated` assertion in `tests/consumer/src/main.ts` and `tests/consumer-rsbuild/src/index.ts`.

- [ ] **Step 2: Run the consumer smoke — this is the acceptance test**

Run: `pnpm test:consumer`
Expected: 11/11 stages pass, across all four modes (Vite dev, Vite build + preview, rsbuild preview, no-bundler static serve), with no COOP/COEP header served anywhere. That is the proof the library no longer imposes cross-origin isolation.

If a stage fails, stop and diagnose before touching anything else: something still reads a `SharedArrayBuffer`.

- [ ] **Step 3: Remove the rstest plugin**

In `rstest.config.ts`, keep the plugin but strip it to its one remaining job. Delete the `server.headers` block; keep `dev.browserLogs: false`, which exists for an unrelated reason — rsbuild's HMR client calls `window.location.reload()` inside worker bundles without a `typeof window` guard, and the noise is not something removing the SAB fixes. Rename the plugin to `rsbuild:silence-worker-hmr-logs` and update its comment, so nobody later reads a cross-origin name over browser-log config.

- [ ] **Step 4: Update the README**

Remove the cross-origin isolation section (`README.md:210-250`) — the required-headers list, the nginx snippet, the Node snippet and the bundler config block. Replace it with a short note stating that browser-sqlite requires no special headers, that OPFS access handles work in a plain worker context, and that `OPFSAdaptiveVFS` still requires JSPI, which is an unrelated constraint.

Check the rest of the README for stragglers: `grep -n "COOP\|COEP\|cross-origin\|SharedArrayBuffer\|crossOriginIsolated" README.md`.

- [ ] **Step 5: Run everything**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test && pnpm test:consumer`
Expected: 291 tests and 11/11 smoke stages, with no isolation headers anywhere in the repo.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat!: browser-sqlite no longer requires cross-origin isolation

The SharedArrayBuffer was the only thing that ever needed COOP/COEP, and
it was ours, not wa-sqlite's: no VFS requires isolation, and upstream's
own comparison table has a "No COOP/COEP requirements" row ticked for
every one of them.

The headers are gone from the test server, both consumer apps, the rstest
browser plugin and the README. The consumer smoke passing 11/11 across
four bundler modes with no header served anywhere is the demonstration,
which is what D2 was for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Spec §6.2 coverage map

| Spec property | Test | Task |
|---|---|---|
| An abort posted mid-query is seen promptly | `does not restart the worker when a stream is abandoned` (the stop reaches a parked worker) and `is still interruptible, and its worker survives` (it reaches one producing no chunks) | 2, 7 |
| A filtering scan stays interruptible | `is still interruptible, and its worker survives` | 7 |
| `first()` does not kill its worker | `costs exactly one row, and never restarts its worker` | 3 |
| A slow consumer does not make chunks pile up | `does not let the worker run ahead of a slow consumer` | 2 |
| `close()` during a query completes cleanly | `stops the query first, then closes` | 4 |

## Closing the wave

After Task 8, update `mem:follow-ups` (BP-1 and W-sab move to **done**, with evidence) and `mem:resume-plan` (§0 and the wave table), then use `superpowers:requesting-code-review` for a whole-branch review before merging. Wave 4 still owes the commit-propagation barrier and D6 — both come after this plan, and the barrier gets its own brainstorming (spec §9).
