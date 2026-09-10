# Transaction closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A transaction ends once and its handle knows it: an abandoned write abandons its
transaction on every build, a closed `tx` never reaches the worker again, and `tx.signal` lets
the callback stop its own work.

**Architecture:** The worker reports `inTransaction` (from `sqlite3_get_autocommit`) on every
query reply; `pool.ts` records it on the `PoolWorker`. `transaction.ts` gains one piece of
state — how the transaction ended — read at the entry of every `tx` method, and an internal
`AbortController` merged into its signal through which the new causes of death join the
existing race. `bulk.ts` reports its own abandonment to a transaction through an optional hook.

**Tech Stack:** TypeScript, wa-sqlite in a Web Worker, rstest (unit on Node, browser on
Chromium + Firefox through Playwright), Biome.

**Spec:** `docs/superpowers/specs/2026-09-10-transaction-abort-design.md` — read it whole
before any task; every rule below is cited as R1-R8 / D1-D11 from it. Its §1 holds the
measurements that justify each rule, and its §8 records M1 (already done — the read premise of
R7 holds; `SQLITE_FULL` cannot be provoked in a browser, so D6's test is a unit test only).

## Global Constraints

- **Serena first for code.** Explore with `get_symbols_overview`, read with `find_symbol`
  (`include_body: true`), find callers with `find_referencing_symbols`, edit with
  `replace_symbol_body` / `insert_before_symbol` / `insert_after_symbol` / `replace_content`.
  Built-in Read/Edit on code only as a fallback (e.g. inside `describe`/`it` bodies). Read/Edit
  are fine for `.md`. Never `rename_symbol` in a file whose body you replaced in the same
  session. Every subagent prompt that touches code carries this rule.
- **Every commit lands green.** The pre-commit hook runs the whole suite (three configs,
  several minutes) and refuses a red tree. Never `--no-verify`. So each task's failing test and
  the code that satisfies it land in ONE commit; the RED run in each task is observed, not
  committed.
- **After every modification:** `pnpm check` (Biome; 13 warnings and 1 info are the baseline,
  none of them ours), then `pnpm exec tsc --noEmit` (clean).
- **Read four fields on each of the three reports** of `pnpm test`: `status`, `failedFiles`,
  passed and failed counts. Baseline on this branch: 681 tests / 58 files (1 skipped), 266 / 39
  (1 skipped), 5 / 2, all `status: pass`, `failedFiles: 0`. A skip count of 1 on each browser
  config is expected.
- **Single-file runs:** `pnpm exec rstest --project chromium run <file>`,
  `pnpm exec rstest -c rstest.firefox.config.ts run <file>`,
  `pnpm exec rstest --project unit run <file>`. Browser tests run on BOTH engines.
- **Falsifiability is observed, never argued.** Each task names a mutation. Apply it, run the
  task's tests, see them red, restore, see them green, and report both runs per engine. A test
  that stays green under its mutation is deleted or rewritten, not reworded.
- **An assertion inside an abandoned callback is swallowed** — `transaction.ts` attaches
  `running.catch(() => {})` — and the transaction rejects BEFORE the callback finishes. Capture
  values inside the callback, resolve a `finished` deferred as its last line, await it, and
  assert outside.
- **Error codes are compared with `toMatchObject({ code })`; a `cause` with
  `expect((e as Error).cause).toBe(reason)`** — `cause` is a non-enumerable own property.
- **Commit messages:** conventional (`fix(transaction): …`), a short body, ending with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Out of bounds:** `.serena/memories/`, `.scratchpad/`, pushing, merging, switching branches.
- **Push back.** If a step contradicts the code, stop and report — the plan was written by the
  same head as the spec, and in this repository that has produced plan defects before.

## File map

| File | Change |
|---|---|
| `src/types.ts` | `inTransaction?: boolean` on the `done` and `error` members of `WorkerMessageData` (Task 1) |
| `src/worker/worker.ts` | reads `get_autocommit` after every query, sends it with the reply (Task 1) |
| `src/pool.ts` | `PoolWorker.inTransaction`, updated in `onmessage` (Task 1) |
| `src/errors.ts` | `'TRANSACTION_CLOSED'` in `SQLiteErrorCode` (Task 2) |
| `src/transaction.ts` | teardown asks the connection (1); ending state, guards, R4 (2); death controller, triggers (3); `onAbandoned` wiring (4); `signal` on the handle (5) |
| `src/client.ts` | passes `logger` to `createTransaction` (Task 2) |
| `src/bulk.ts` | optional `onAbandoned` on the target, called by `bulkWrite` (Task 4) |
| `src/api.ts` | `readonly signal: AbortSignal` on `SQLiteTransactionDB` (Task 5) |
| `tests/unit/transaction.test.ts` | fake worker reports `inTransaction` (1); harness takes a logger, R4 table, flipped test (2); death triggers (3) |
| `tests/browser/tx-abort.test.ts` | new: spec §8 tests 1-8 (Tasks 1, 3, 4) |
| `tests/browser/tx-handle.test.ts` | new: spec §8 tests 9-11 (Tasks 2, 5) |
| `tests/browser/close.test.ts` | one expectation flips (Task 2) |
| `tests/browser/tx-timeout.test.ts` | header comment corrected (Task 3) |
| `API.md`, `CHANGELOG.md` | Task 6 |

---

### Task 1: The connection reports whether it is in a transaction, and the teardown asks it (R6)

**Files:**
- Modify: `src/types.ts` (`WorkerMessageData`), `src/worker/worker.ts` (the `query` case of
  `self.onmessage`), `src/pool.ts` (`PoolWorker`, `createPoolWorker/onmessage`),
  `src/transaction.ts` (the `catch` of the inner `try`)
- Test: `tests/unit/transaction.test.ts`, `tests/browser/tx-abort.test.ts` (create)

**Interfaces:**
- Produces: `PoolWorker.inTransaction?: boolean` — the connection's state when its last query
  ended, `undefined` before any report. Tasks 2 and 3 read it after `worker.quiesce()`.
- Produces: `fakeWorker(failOn, hooks, leaveOn)` in the unit test file, whose returned object
  carries a mutable `inTransaction`.

- [ ] **Step 1: Make the unit fake report the connection's state.** Replace `fakeWorker` in
  `tests/unit/transaction.test.ts` with:

```ts
/**
 * A worker whose statements can be made to fail by name, and whose statements
 * can be suspended — `hooks` runs before the statement yields, keyed by SQL
 * prefix, which is how a test gets a statement to still be in flight when the
 * signal fires.
 *
 * Like the real worker it reports whether its connection is in a transaction
 * once a statement ends: open after BEGIN, closed after a COMMIT or ROLLBACK
 * that succeeded, and closed after any statement named in `leaveOn` — which is
 * how a test makes SQLite leave the transaction by itself.
 */
const fakeWorker = (
  failOn: string[],
  hooks: Record<string, () => Promise<void> | void> = {},
  leaveOn: string[] = [],
) => {
  const executed: string[] = [];
  const worker = {
    index: 3,
    executed,
    inTransaction: undefined as boolean | undefined,
    query: async function* (sql: string) {
      executed.push(sql);
      const fails = failOn.some((needle) => sql.startsWith(needle));
      try {
        for (const [needle, hook] of Object.entries(hooks))
          if (sql.startsWith(needle)) await hook();
        if (fails) throw new SQLiteError('BUSY', `database is locked (${sql})`);
        yield [] as Record<string, unknown>[];
      } finally {
        if (!fails && sql.startsWith('BEGIN')) worker.inTransaction = true;
        else if (!fails && /^(COMMIT|ROLLBACK)/.test(sql))
          worker.inTransaction = false;
        if (leaveOn.some((needle) => sql.startsWith(needle)))
          worker.inTransaction = false;
      }
    },
    interrupt: () => {},
    quiesce: async () => {},
  };
  return worker;
};
```

- [ ] **Step 2: Add the unit tests** at the end of the `transaction — a poisoned connection is
  never re-lent` describe block:

```ts
  // Falsifiable: drop the `worker.inTransaction !== false` condition around the
  // fallback ROLLBACK in src/transaction.ts and a ROLLBACK is sent — which the
  // real SQLite refuses, and refusing it evicts a healthy worker (spec §1.1).
  it('sends no ROLLBACK, and loses no worker, when the connection already left', async () => {
    const worker = fakeWorker(['INSERT'], {}, ['INSERT']);
    const { transaction, poisoned } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)']);
    expect(poisoned).toEqual([]);
  });

  it('still rolls back a connection that reports its transaction open', async () => {
    const worker = fakeWorker(['INSERT']);
    const { transaction } = harness(worker);

    await expect(
      transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      }),
    ).rejects.toBeInstanceOf(SQLiteError);

    expect(worker.executed).toEqual([
      'BEGIN',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
```

- [ ] **Step 3: Create `tests/browser/tx-abort.test.ts`** with the shared helpers and spec §8
  test 2:

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * One INSERT whose single step() runs for hundreds of milliseconds (Chromium)
 * to seconds (Firefox), so an abort at 30 ms lands inside it on a build that
 * can cut a running step.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

type Debuggable = { debug: { workers: { creationTime: number }[] } };

/** The pool's workers by birth time: a change means one was evicted and respawned. */
const workerIdentity = (db: unknown) =>
  (db as Debuggable).debug.workers.map((w) => w.creationTime).join(',');

const abortAfter = (ms: number, reason: unknown) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(reason), ms);
  return ctl.signal;
};

const setUp = async (options: { vfs: 'MemoryVFS' | 'OPFSAdaptiveVFS'; build?: 'sync' | 'async' }) => {
  const db = await createTestClient({ ...options, poolSize: 1, debug: true });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  await db.write('INSERT INTO t VALUES (0)');
  return db;
};

describe('a write abandoned inside a transaction', () => {
  /**
   * Spec §1.1: on a build that can cut a running step, SQLite rolls the whole
   * transaction back; the fallback ROLLBACK then failed and evicted the worker —
   * which, on a memory VFS, replaced the database with an empty one (`no such
   * table: t`). Falsifiable: drop the `worker.inTransaction !== false` condition
   * in transaction.ts's catch.
   */
  it('costs no worker and no committed data when the callback does not catch it', async () => {
    const db = await setUp({ vfs: 'MemoryVFS', build: 'async' });
    try {
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');

      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write(BIG_INSERT, [], { signal: abortAfter(30, reason) });
        }),
      ).rejects.toBe(reason);

      expect(workerIdentity(db)).toBe(before);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
```

  If `createTestClient`'s option type refuses `build` or `debug`, read `TestClientOptions` in
  `tests/browser/helpers.ts` — `tests/browser/vfs.test.ts` already passes `build: 'async'` —
  and widen the call the way that file does rather than casting to `never`.

- [ ] **Step 4: Run the new tests and see them fail.** Unit: the first new test fails — a
  `ROLLBACK` is in `executed` (the fake accepts it; the real SQLite refuses it, which is what
  evicts). Browser, both engines: the test fails — `no such table: t` on the read, or the
  identity differs.

- [ ] **Step 5: Implement the report.** In `src/types.ts`, add to BOTH the `done` and the
  `error` members of `WorkerMessageData`:

```ts
      /**
       * Whether the connection is inside a transaction once this query has
       * ended — `sqlite3_get_autocommit() === 0`. SQLite can leave a
       * transaction by itself: an interrupted INSERT/UPDATE/DELETE rolls the
       * whole transaction back. Absent when the worker could not read it.
       */
      inTransaction?: boolean;
```

  In `src/worker/worker.ts`, add a module-level helper before `self.onmessage` (it reads the
  module-level `openedDB`, as the `close` case does):

```ts
/**
 * Whether the connection is inside a transaction right now. Read after every
 * query and sent with its reply, because SQLite can leave a transaction by
 * itself — an interrupted write rolls the whole transaction back
 * (https://www.sqlite.org/c3ref/interrupt.html) — and the client has no other
 * way to learn it. `undefined` when no connection is open.
 */
const connectionInTransaction = async (): Promise<boolean | undefined> => {
  try {
    const { sqlite, db } = await openedDB!;
    return sqlite.get_autocommit(db) === 0;
  } catch {
    return undefined;
  }
};
```

  In the `query` case, add `inTransaction: await connectionInTransaction()` to all three
  replies: the `closing` error, the `done`, and the error built in the `catch`.

  In `src/pool.ts`, add to the `PoolWorker` type, after `epochTarget`:

```ts
  /**
   * Whether the connection was inside a transaction when its last query
   * ended, as the worker read it (`sqlite3_get_autocommit`). `undefined` until
   * a query has reported it.
   *
   * CONNECTION state, not availability: nothing schedules on it and nothing
   * may. Availability lives in `scheduler.ts` alone — see the `available`
   * declaration there — and a flag on this object that the pool consulted would
   * reopen B1. Its one reader is `transaction.ts`, which asks it whether a
   * ROLLBACK is still owed and whether its transaction is still alive.
   */
  inTransaction?: boolean;
```

  In `createPoolWorker/onmessage`, inside the `if (deferredChunk && callId === currentCallId)`
  block of BOTH `case 'done'` and `case 'error'`, first line:
  `worker.inTransaction = data.inTransaction;`. This is the right place even for an abandoned
  query: the stop-and-drain in `runQuery`'s `finally` waits `while (deferredChunk)`, and it is
  this block that clears it, so the reply is processed here before `idle` resolves — which is
  what makes the value fresh once `quiesce()` returns. Verify that by reading before relying on
  it.

- [ ] **Step 6: Make the teardown ask.** In `src/transaction.ts`, in the `catch (e)` of the
  inner `try`, replace `if (begun && !done) { try { await db.rollback(); } catch { … } }` with
  the same block guarded by the connection's report — keep the existing comment inside the
  `catch` verbatim:

```ts
        // SQLite may already have left the transaction by itself — an
        // interrupted write rolls the whole transaction back. A ROLLBACK then
        // fails, and failing it evicted a healthy worker (spec §1.1, R6). A
        // worker that has reported nothing yet counts as open: the default can
        // only cost a ROLLBACK that fails, never skip one that was owed.
        if (begun && !done && worker.inTransaction !== false) {
          try {
            await db.rollback();
          } catch {
            // (existing comment and onPoisoned call, unchanged)
          }
        }
```

- [ ] **Step 7: Run the task's tests, green on both engines;** then the falsifier — drop
  `&& worker.inTransaction !== false`, see the new unit test and the browser test red on both
  engines, restore. `pnpm check`, `pnpm exec tsc --noEmit`, `pnpm test` (four fields × three).

- [ ] **Step 8: Commit**

```bash
git add src/types.ts src/worker/worker.ts src/pool.ts src/transaction.ts tests/unit/transaction.test.ts tests/browser/tx-abort.test.ts
git commit   # fix(transaction): ask the connection before rolling back
```

---

### Task 2: A transaction handle closes when its transaction ends (R3, R4, D2, D7, D8)

**Files:**
- Modify: `src/errors.ts` (`SQLiteErrorCode`), `src/transaction.ts` (`createTransaction`),
  `src/client.ts` (the `createTransaction({...})` call)
- Test: `tests/unit/transaction.test.ts`, `tests/browser/tx-handle.test.ts` (create),
  `tests/browser/close.test.ts`

**Interfaces:**
- Consumes: `PoolWorker.inTransaction` (Task 1).
- Produces, inside `createTransaction`'s returned function: `type Ending = { kind: 'committed' }
  | { kind: 'rolled-back' } | { kind: 'died'; cause: unknown }`, `let ending: Ending |
  undefined`, `closedError(end: Ending): SQLiteError`, `commitNow(): Promise<void>`,
  `rollbackNow(): Promise<void>`. Task 3 adds a way to die; Task 5 exposes the signal.
- Produces: `deps.logger: Pick<Logger, 'always'>` on `createTransaction`.

- [ ] **Step 1: Give the unit harness a logger.** In `tests/unit/transaction.test.ts`:

```ts
const harness = (worker: ReturnType<typeof fakeWorker>) => {
  const poisoned: number[] = [];
  const warnings: string[] = [];
  const scheduler = {
    // Mirrors the real scheduler: the signal aborts the WAIT, rejecting with
    // `signal.reason` while the request is still queued.
    acquire: async (_kind: 'read' | 'write', signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return { worker, release: () => {} };
    },
  };
  const transaction = createTransaction({
    scheduler: scheduler as never,
    afterWrite: () => Promise.resolve(),
    onPoisoned: (index: number) => poisoned.push(index),
    // Never aborted here: these tests are about the caller's own signal, and a
    // client that never closes is the state they all assume.
    closeSignal: new AbortController().signal,
    bulkFor: () => ({
      bulkWrite: () => ({ enqueue: async () => {}, close: async () => 0 }),
      output: () => ({ enqueue: async () => {}, close: async () => 0 }),
    }),
    logger: { always: { warn: (message: string) => warnings.push(message) } },
  });
  return { transaction, poisoned, warnings };
};
```

- [ ] **Step 2: Flip the released-behaviour test.** In *refuses an explicit commit() once the
  signal has fired*, replace `expect(commitError).toBe(reason);` with:

```ts
    // The breaking change of spec R3: a statement on a transaction that is over
    // reports TRANSACTION_CLOSED, carrying why it is over.
    expect(commitError).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((commitError as Error).cause).toBe(reason);
```

  The two other assertions of that test stay as they are.

- [ ] **Step 3: Add the R4 table as unit tests,** in a new describe at the end of the file.
  Import `SQLiteTransactionDB` as a type from `'../../src/api'`.

```ts
describe('transaction — a closed handle never reaches the worker (spec R3, R4)', () => {
  // Falsifiable, all three: remove the `if (ending)` guard from commit(),
  // rollback() or write() in src/transaction.ts and `executed` grows.
  it('after a commit: commit() resolves, rollback() resolves and warns, a statement is refused', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(async (tx) => {
      kept = tx;
      await tx.write('INSERT INTO t VALUES (1)');
    });
    const executed = [...worker.executed];

    await expect(kept.commit()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    const refused = await kept.write('INSERT INTO t VALUES (2)').catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBeUndefined();
    expect(worker.executed).toEqual(executed);
  });

  it('after a rollback: commit() is refused, rollback() resolves silently', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    let kept!: SQLiteTransactionDB;
    await transaction(
      async (tx) => {
        kept = tx;
        await tx.write('INSERT INTO t VALUES (1)');
      },
      { autoCommit: false },
    );
    const executed = [...worker.executed];
    expect(executed.at(-1)).toBe('ROLLBACK');

    const refused = await kept.commit().catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBeUndefined();
    await expect(kept.rollback()).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
    expect(worker.executed).toEqual(executed);
  });

  it('after a death: commit() is refused with the cause, rollback() resolves silently', async () => {
    const worker = fakeWorker([]);
    const { transaction, warnings } = harness(worker);
    const ctl = new AbortController();
    const reason = new Error('abandoned');
    let kept!: SQLiteTransactionDB;
    const entered = deferred();
    const finished = deferred();
    const running = transaction(
      async (tx) => {
        kept = tx;
        entered.resolve();
        await finished.promise;
      },
      { signal: ctl.signal },
    );
    // Abort only once the callback runs: aborting earlier refuses the BEGIN and
    // the callback — and `kept` — never exist.
    await entered.promise;
    ctl.abort(reason);
    await expect(running).rejects.toBe(reason);
    finished.resolve();
    const executed = [...worker.executed];

    const refused = await kept.commit().catch((e) => e);
    expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((refused as Error).cause).toBe(reason);
    await expect(kept.rollback()).resolves.toBeUndefined();
    const statement = await kept.read('SELECT 1').catch((e) => e);
    expect(statement).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((statement as Error).cause).toBe(reason);
    expect(warnings).toEqual([]);
    expect(worker.executed).toEqual(executed);
  });
});
```

  Place this block at the end of the file, after `deferred` and `never` are declared.

- [ ] **Step 4: Flip the browser expectation** in `tests/browser/close.test.ts`, *rejects —
  never hangs — a statement the callback issues after close()*: `toBe('CLIENT_CLOSED')` becomes
  `toBe('TRANSACTION_CLOSED')`, and add above it a one-line comment: `// Spec R3: the statement
  reports the closed handle; the transaction itself still rejects with CLIENT_CLOSED (the test
  above).` Leave *settles a transaction whose callback is still running* unchanged.

- [ ] **Step 5: Create `tests/browser/tx-handle.test.ts`** — spec §8 tests 9 and 10:

```ts
import { describe, expect, it } from '@rstest/core';
import type { SQLiteTransactionDB } from '../../src/api';
import { createTestClient } from './helpers';

type Debuggable = { debug: { workers: { creationTime: number }[] } };
const workerIdentity = (db: unknown) =>
  (db as Debuggable).debug.workers.map((w) => w.creationTime).join(',');

const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

/**
 * Transaction B on a `poolSize: 1` client — so on the worker the previous
 * transaction used — paused between its two statements while the test does
 * something with an older handle.
 */
const pausedTransaction = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  const inside = gate();
  const resume = gate();
  const done = db.transaction(async (tx) => {
    await tx.write("INSERT INTO t VALUES ('b1')");
    inside.open();
    await resume.promise;
    await tx.write("INSERT INTO t VALUES ('b2')");
  });
  done.catch(() => {});
  await inside.promise;
  return { resume: resume.open, done };
};

describe('a transaction handle used after its transaction ended (spec §1.2)', () => {
  // Falsifiable, all three: remove the `if (ending)` guards in transaction.ts's
  // rollback() and write(); B is destroyed or contaminated, as measured.
  it("an abandoned transaction's rollback() leaves the next transaction alone", async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      const before = workerIdentity(db);
      const ctl = new AbortController();
      const entered = gate();
      const late = gate();
      let kept!: SQLiteTransactionDB;
      const a = db.transaction(
        async (tx) => {
          kept = tx;
          await tx.write("INSERT INTO t VALUES ('a1')");
          entered.open();
          await late.promise;
        },
        { signal: ctl.signal },
      );
      a.catch(() => {});
      await entered.promise;
      ctl.abort(new Error('abandon A'));
      await expect(a).rejects.toThrow('abandon A');

      const b = await pausedTransaction(db);
      await expect(kept.rollback()).resolves.toBeUndefined();
      b.resume();
      await expect(b.done).resolves.toBeUndefined();
      late.open();

      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 'b1' }, { a: 'b2' }]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  });

  it("a committed transaction's rollback() leaves the next transaction alone", async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      let kept!: SQLiteTransactionDB;
      await db.transaction(async (tx) => {
        kept = tx;
        await tx.write("INSERT INTO t VALUES ('a1')");
      });

      const b = await pausedTransaction(db);
      await expect(kept.rollback()).resolves.toBeUndefined();
      b.resume();
      await expect(b.done).resolves.toBeUndefined();

      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 'a1' },
        { a: 'b1' },
        { a: 'b2' },
      ]);
    } finally {
      await db.close();
    }
  });

  it("a committed transaction's write() is refused and lands nowhere", async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a TEXT)');
      let kept!: SQLiteTransactionDB;
      await db.transaction(async (tx) => {
        kept = tx;
        await tx.write("INSERT INTO t VALUES ('a1')");
      });

      const b = await pausedTransaction(db);
      const refused = await kept.write("INSERT INTO t VALUES ('late')").catch((e) => e);
      b.resume();
      await expect(b.done).resolves.toBeUndefined();

      expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((refused as Error).cause).toBeUndefined();
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 'a1' },
        { a: 'b1' },
        { a: 'b2' },
      ]);
    } finally {
      await db.close();
    }
  });
});

describe('a statement after an explicit end, inside the callback', () => {
  // Falsifiable: remove the `if (ending)` guard in transaction.ts's write();
  // the statement runs in autocommit on the leased worker and lands.
  it.each(['commit', 'rollback'] as const)(
    'is refused after tx.%s() under autoCommit: false',
    async (end) => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.write('CREATE TABLE t (a TEXT)');
        let refused: unknown;
        await db.transaction(
          async (tx) => {
            await tx.write("INSERT INTO t VALUES ('in')");
            await tx[end]();
            refused = await tx.write("INSERT INTO t VALUES ('after')").catch((e) => e);
          },
          { autoCommit: false },
        );
        expect(refused).toMatchObject({ code: 'TRANSACTION_CLOSED' });
        const rows = await db.read('SELECT a FROM t ORDER BY a');
        expect(rows).toEqual(end === 'commit' ? [{ a: 'in' }] : []);
      } finally {
        await db.close();
      }
    },
  );
});
```

  If rstest has no `it.each`, write the two cases out.

- [ ] **Step 6: Run the new and flipped tests and see them fail** (unit and both engines).

- [ ] **Step 7: Implement.** In `src/errors.ts`, add `| 'TRANSACTION_CLOSED'` to
  `SQLiteErrorCode`. In `src/client.ts`, add `logger,` to the object passed to
  `createTransaction`. In `src/transaction.ts`:

  1. `import type { Logger } from './logger';` and add to `deps`:

```ts
    /**
     * Reached only through `always`: `rollback()` on a transaction that has
     * already committed warns whatever the `debug` option says (spec R4) — a
     * warning visible only under debug would be the same as silence.
     */
    logger: Pick<Logger, 'always'>;
```

  2. Right after the `mergeSignals(deadline, deps.closeSignal)` line, before `try`:

```ts
    /**
     * How this transaction ended, set exactly once (spec §4). Every public
     * method of the handle reads it at its entry: once it is set, nothing the
     * handle does reaches the worker, which by then may be serving someone
     * else (spec §1.2).
     */
    type Ending =
      | { kind: 'committed' }
      | { kind: 'rolled-back' }
      | { kind: 'died'; cause: unknown };
    let ending: Ending | undefined;
    // The existing causes of death — the caller's signal, the timeout,
    // close() — all abort `signal`; this is where they become an ending.
    const onAbort = () => {
      ending ??= { kind: 'died', cause: signal?.reason };
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const closedError = (end: Ending): SQLiteError =>
      new SQLiteError(
        'TRANSACTION_CLOSED',
        end.kind === 'died'
          ? 'This transaction was abandoned; nothing more can run in it.'
          : `This transaction has already ${end.kind === 'committed' ? 'committed' : 'rolled back'}; nothing more can run in it.`,
        end.kind === 'died' ? { cause: end.cause } : undefined,
      );
```

     and in the OUTER `finally`, first line: `signal?.removeEventListener('abort', onAbort);`.

  3. After `let begun = false;`, the two internal ends — the teardown must use these, NEVER
     the public `commit()`/`rollback()`, which return without reaching the worker once the
     handle is closed and would leave the connection's transaction open:

```ts
      // The SQL ends, for the transaction's own use. `??=` keeps a death that
      // landed while the statement was in flight: BEGIN, COMMIT and ROLLBACK
      // carry no signal, so an abort can arrive during one.
      const commitNow = async () => {
        await exec(worker, 'COMMIT');
        done = true;
        ending ??= { kind: 'committed' };
      };
      const rollbackNow = async () => {
        await exec(worker, 'ROLLBACK');
        done = true;
        ending ??= { kind: 'rolled-back' };
      };
```

  4. Guards. `read`, `write`, `first` in `db`, and `read`, `write` in the `bulkFor` target,
     each begin with `if (ending) return Promise.reject(closedError(ending));` — before
     `checksql`. In `releasing`, the generator body's `try` begins with
     `if (ending) throw closedError(ending);` before `yield* source;` (so `chunk`/`stream`
     refuse at the first `next()`, as R3 says). `bulkWrite` and `output` in `db` become:

```ts
        bulkWrite: ((...args: Parameters<SQLiteQueryAPI['bulkWrite']>) => {
          if (ending) throw closedError(ending);
          return bulk.bulkWrite(...args);
        }) as SQLiteQueryAPI['bulkWrite'],
        output: ((...args: Parameters<SQLiteQueryAPI['output']>) => {
          if (ending) throw closedError(ending);
          return bulk.output(...args);
        }) as SQLiteQueryAPI['output'],
```

  5. `commit` and `rollback` in `db` become (the old `commit()` comment about refusing a
     COMMIT after an abort moves onto the `if (ending)` line — the listener sets `ending`
     synchronously when the signal aborts, so the guard covers what `throwIfAborted()` did):

```ts
        commit: async () => {
          if (ending) {
            if (ending.kind === 'committed') return;
            throw closedError(ending);
          }
          await commitNow();
        },

        rollback: async () => {
          if (ending) {
            if (ending.kind === 'committed')
              deps.logger.always.warn(
                'rollback() was called on a transaction that has already committed; nothing was rolled back.',
              );
            return;
          }
          await rollbackNow();
        },
```

  6. The auto path after `closeOpenStatements()`:

```ts
        if (!done) {
          // An abort that landed after the callback returned — during
          // closeOpenStatements() — still refuses the COMMIT, and with the
          // cause rather than TRANSACTION_CLOSED: this is the transaction's own
          // outcome (spec R2), not a late statement.
          signal?.throwIfAborted();
          if (autoCommit) await commitNow();
          else await rollbackNow();
        }
```

  7. In the `catch`, the guarded fallback from Task 1 calls `rollbackNow()` instead of
     `db.rollback()`.

  8. The inner `finally`, first line — before the lease can go back to the pool:

```ts
        // No path out of transaction() may leave the handle open (spec §4).
        ending ??= { kind: 'rolled-back' };
```

- [ ] **Step 8: Run green, then the falsifiers** named in the tests (each `if (ending)` guard
  removed in turn, red on the matching tests, restored). `pnpm check`, `tsc`, `pnpm test`.
  Every other existing test must stay green; one that moves is a finding to report, not to
  adjust.

- [ ] **Step 9: Commit**

```bash
git add src/errors.ts src/transaction.ts src/client.ts tests/unit/transaction.test.ts tests/browser/tx-handle.test.ts tests/browser/close.test.ts
git commit   # fix(transaction): a transaction's handle closes when it ends
```

---

### Task 3: An abandoned write, or a connection that left, kills the transaction (R1, R2, R5, D4-D6)

**Files:**
- Modify: `src/transaction.ts`
- Test: `tests/unit/transaction.test.ts`, `tests/browser/tx-abort.test.ts`,
  `tests/browser/tx-timeout.test.ts` (header only)

**Interfaces:**
- Consumes: `ending`, `closedError`, `rollbackNow` (Task 2); `worker.inTransaction` (Task 1).
- Produces: `die(cause: unknown): void`, and `signal` narrowed to `AbortSignal` (the merged
  signal including the death controller). Task 4 calls `die`; Task 5 exposes `signal`.

- [ ] **Step 1: Unit tests,** at the end of `tests/unit/transaction.test.ts`:

```ts
describe('transaction — what else kills it (spec R1)', () => {
  // Falsifiable: remove the dieIfConnectionLeft() call from `settled` in
  // src/transaction.ts; the SELECT runs in what is now autocommit.
  it('dies when the connection reports it left the transaction', async () => {
    const worker = fakeWorker(['INSERT'], {}, ['INSERT']);
    const { transaction, poisoned } = harness(worker);
    let first: unknown;
    let later: unknown;
    const finished = deferred();
    const running = transaction(async (tx) => {
      first = await tx.write('INSERT INTO t VALUES (1)').catch((e) => e);
      later = await tx.read('SELECT 1').catch((e) => e);
      finished.resolve();
    });
    // Captured, not `rejects.toBe(first)`: that would read `first` before the
    // callback has assigned it.
    const outcome = await running.catch((e) => e);
    await finished.promise;
    expect(first).toBeInstanceOf(SQLiteError);
    expect(outcome).toBe(first);
    expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect((later as Error).cause).toBe(first);
    expect(worker.executed).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)']);
    expect(poisoned).toEqual([]);
  });

  // Falsifiable: remove the isAbandonedWrite() → die() line from `settled`;
  // the callback's next statement runs and the transaction commits.
  it('dies when a write is abandoned by its own signal, and rolls back what is open (R5)', async () => {
    const worker = fakeWorker([], { 'INSERT INTO t VALUES (1)': never });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this write only');
    let later: unknown;
    const finished = deferred();
    const running = transaction(async (tx) => {
      const pending = tx.write('INSERT INTO t VALUES (1)', [], { signal: own.signal });
      own.abort(reason);
      await pending.catch(() => {});
      later = await tx.write('INSERT INTO t VALUES (2)').catch((e) => e);
      finished.resolve();
    });
    await expect(running).rejects.toBe(reason);
    await finished.promise;
    expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
    expect(worker.executed).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)', 'ROLLBACK']);
  });

  it('does not die when a read is abandoned by its own signal (R7)', async () => {
    const worker = fakeWorker([], { 'SELECT slow': never });
    const { transaction } = harness(worker);
    const own = new AbortController();
    await transaction(async (tx) => {
      const pending = tx.read('SELECT slow', [], { signal: own.signal });
      own.abort(new Error('this read only'));
      await pending.catch(() => {});
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual(['BEGIN', 'SELECT slow', 'INSERT INTO t VALUES (2)', 'COMMIT']);
  });
});
```

  `'SELECT slow'` is not valid SQL, which the fake does not care about; `isReadQuery` must
  classify it as a read — check `src/utils.ts` and pick a string it does if not.

- [ ] **Step 2: Browser tests** — append to `tests/browser/tx-abort.test.ts`, in the same
  describe (spec §8 tests 1, 3, 4, 5, 6, 7). Add `longQuery` to the helpers import and a
  deferred helper at the top of the file:

```ts
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
```

```ts
  // Falsifiable for 1, 3, 4, 5: remove the isAbandonedWrite() → die() line
  // from `settled` in transaction.ts.
  it('abandons the transaction when the callback catches it (async)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');
      let caught: unknown;
      let later: unknown;
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx.write(BIG_INSERT, [], { signal: abortAfter(30, reason) }).catch((e) => e);
          later = await tx.read('SELECT a FROM t').catch((e) => e);
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(caught).toBe(reason);
      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((later as Error).cause).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([{ n: 0 }]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Spec §1.1, last row: nothing could cut the step, the write completed, and
  // its rows used to commit although the caller got a rejection.
  it('keeps none of a write that ran to its end on the sync build (R5)', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('abandon the write');
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.write(BIG_INSERT, [], { signal: abortAfter(30, reason) }).catch(() => {});
          await tx.write('INSERT INTO t VALUES (2)').catch(() => {});
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([{ n: 0 }]);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('abandons the transaction for a write whose signal was already aborted (D4)', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('never started');
      const ctl = new AbortController();
      ctl.abort(reason);
      let later: unknown;
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write('INSERT INTO t VALUES (2)', [], { signal: ctl.signal }).catch(() => {});
          later = await tx.write('INSERT INTO t VALUES (3)').catch((e) => e);
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('abandons the transaction for a write abandoned by its own timeout', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      let caught: unknown;
      const finished = deferred();
      const outcome = await db
        .transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx.write(BIG_INSERT, [], { timeout: 30 }).catch((e) => e);
          finished.resolve();
        })
        .catch((e) => e);
      await finished.promise;

      expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 30 });
      expect(outcome).toBe(caught);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Falsifiable: make isAbandonedWrite() ignore the SQL (`isWriteQuery(sql)` →
  // `true`); the transaction dies and this goes red.
  it('does not abandon the transaction for an abandoned read (R7)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const slow = longQuery(20_000_000);
      // Prepare and cache the exact statement first, so the measured run takes
      // the cached path and the abort lands inside step() (mem:lessons, 2026-09-05).
      await db.read(slow, [], { timeout: 50 }).catch(() => {});
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.read(slow, [], { signal: abortAfter(30, new Error('this read only')) }).catch(() => {});
        await tx.write('INSERT INTO t VALUES (2)');
      });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }, { a: 1 }, { a: 2 }]);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Falsifiable: as for the read above — the SQL is the discriminator (D5).
  it('abandons the transaction for a write issued through tx.first()', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('never started');
      const ctl = new AbortController();
      ctl.abort(reason);
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.first('INSERT INTO t VALUES (9) RETURNING a', [], { signal: ctl.signal }).catch(() => {});
          await tx.write('INSERT INTO t VALUES (2)').catch(() => {});
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  });
```

- [ ] **Step 3: Correct step 1's test header.** In `tests/browser/tx-timeout.test.ts`,
  replace `Reads only — see AGENTS.md / the task brief for why writes are deliberately out of
  scope here.` with `Reads only: a write abandoned by its own timeout abandons the whole
  transaction, which tests/browser/tx-abort.test.ts pins.`, and `SQLite installs no progress
  handler at all` with `worker.ts installs no progress handler at all`.

- [ ] **Step 4: Run the new tests and see them fail** (unit and both engines). Test 6 (the
  read) is expected GREEN before the change — it pins a limit, not the fix; confirm it stays
  green after, and goes red under its own mutation.

- [ ] **Step 5: Implement in `src/transaction.ts`.**

  1. Replace the `mergeSignals(deadline, deps.closeSignal)` line with:

```ts
    const { signal: outer, release: releaseClose } = mergeSignals(
      deadline,
      deps.closeSignal,
    );
    // The causes of death decided inside the transaction (spec R1) — an
    // abandoned write, a connection that left — join the three that come from
    // outside by aborting this, so the race, the statements in flight and the
    // handle's ending all see them the same way.
    const death = new AbortController();
    const { signal: merged, release: releaseDeath } = mergeSignals(
      outer,
      death.signal,
    );
    // Never undefined, since death.signal is not — mergeSignals cannot say so.
    const signal = merged ?? death.signal;
```

     and `releaseDeath();` as the first release in the outer `finally`.

  2. After `closedError`:

```ts
    /** Kills the transaction with `cause` (spec R1). Nothing once it has ended. */
    const die = (cause: unknown) => {
      if (!ending) death.abort(cause);
    };
```

  3. After `owesWait`, two helpers:

```ts
      /**
       * Whether `error` is a WRITE abandoned by its own signal or timeout
       * (spec R1). The SQL decides, not the method — read(), first(), chunk()
       * and stream() accept a write too — and a signal already aborted at the
       * call counts (D4).
       */
      const isAbandonedWrite = (
        error: unknown,
        own: AbortSignal | undefined,
        sql: string,
      ) => own?.aborted === true && error === own.reason && isWriteQuery(sql);

      /**
       * Kills the transaction when the connection reports it is no longer in
       * one (spec R1, D6) — read after quiesce(), once the worker's reply has
       * been processed. The cause is the statement's own error, or, when it
       * succeeded, a TRANSACTION_CLOSED naming it (spec R2).
       */
      const dieIfConnectionLeft = (
        failed: boolean,
        error: unknown,
        method: string,
      ) => {
        if (!begun || ending || worker.inTransaction !== false) return;
        die(
          failed
            ? error
            : new SQLiteError(
                'TRANSACTION_CLOSED',
                `The connection left the transaction after ${method}().`,
              ),
        );
      };
```

  4. `withSignal` takes `sql: string` as a third parameter and returns `own: own.signal`
     besides `options`, `release`, `settled` — add `own: AbortSignal | undefined;` to its
     declared return type; `settled` becomes:

```ts
        const settled = async <R>(promise: Promise<R>): Promise<R> => {
          let refused = false;
          let failed = false;
          let error: unknown;
          try {
            return await promise;
          } catch (e) {
            failed = true;
            error = e;
            refused = !owesWait(e);
            // Before the wait, so the transaction — and tx.signal — die at
            // once rather than when the worker is idle again.
            if (isAbandonedWrite(e, own.signal, sql)) die(e);
            throw e;
          } finally {
            release();
            if (!refused) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
        };
```

     Every call site passes its SQL: `withSignal(given, 'read', sql)` and so on, in `db` and in
     the `bulkFor` target.

  5. `releasing(source, release, entry, own, sql, method)` — the generator body mirrors
     `settled`:

```ts
        const gen = (async function* () {
          let refused = false;
          let failed = false;
          let error: unknown;
          try {
            if (ending) throw closedError(ending);
            yield* source;
          } catch (e) {
            failed = true;
            error = e;
            refused = !owesWait(e);
            if (isAbandonedWrite(e, own, sql)) die(e);
            throw e;
          } finally {
            open.delete(entry);
            release();
            if (!refused) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
        })();
```

     (keep the existing comments in that body.) `chunk` and `stream` destructure `own` from
     `withSignal(given, 'chunk' | 'stream', sql)` and pass `own, sql, 'chunk' | 'stream'`.

- [ ] **Step 6: Run green, then the falsifiers** named in the tests. `pnpm check`, `tsc`,
  `pnpm test`. The existing unit tests *aborts a statement that carries a signal of its own*
  and *still honours a statement signal, with its own reason* must stay green unchanged — the
  first pins R3's in-flight rule, the second is now also a death and keeps the same outcome.

- [ ] **Step 7: Commit**

```bash
git add src/transaction.ts tests/unit/transaction.test.ts tests/browser/tx-abort.test.ts tests/browser/tx-timeout.test.ts
git commit   # fix(transaction): an abandoned write abandons its transaction
```

---

### Task 4: `tx.bulkWrite()` and `tx.output()` abandoned kill the transaction (R1)

**Files:**
- Modify: `src/bulk.ts` (the target type of `createBulk`'s returned function, and
  `bulkWrite`), `src/transaction.ts` (the `deps.bulkFor({...})` call)
- Test: `tests/browser/tx-abort.test.ts`

**Interfaces:**
- Consumes: `die` (Task 3).
- Produces: `onAbandoned?: (cause: unknown) => void` on the `bulkFor` target.

- [ ] **Step 1: Browser tests** (spec §8 test 8), appended to `tx-abort.test.ts`. A batch in
  flight when the signal fires is already covered by Task 3 — `bulk.ts` passes its signal down
  to each batch's `write()`. These pin the case where nothing is in flight:

```ts
  // Falsifiable, both: remove the onAbandoned registration in bulk.ts's
  // bulkWrite; the callback goes on and the transaction commits row 1.
  it('abandons the transaction when a tx.bulkWrite is abandoned between batches', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('stop loading');
      const ctl = new AbortController();
      let later: unknown;
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          const writer = tx.bulkWrite('t', ['a'], { signal: ctl.signal });
          await writer.enqueue({ a: 2 });
          ctl.abort(reason);
          await writer.close().catch(() => {});
          later = await tx.read('SELECT a FROM t').catch((e) => e);
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  });

  it('abandons the transaction, and leaves no staging table, when a tx.output is abandoned', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('stop loading');
      const ctl = new AbortController();
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          const out = tx.output('target', { a: 'INTEGER' }, { signal: ctl.signal });
          await out.enqueue({ a: 2 });
          ctl.abort(reason);
          await out.close().catch(() => {});
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
      expect(
        await db.read(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND (name = 'target' OR name LIKE '__bsq_staging_%')",
        ),
      ).toEqual([]);
    } finally {
      await db.close();
    }
  });
```

  Check `output()`'s parameter order in `src/bulk.ts` before running — `tests/browser/
  tx-write.test.ts` calls `tx.output('target', { a: 'INTEGER' })`.

- [ ] **Step 2: Run and see both fail** on both engines.

- [ ] **Step 3: Implement.** In `src/bulk.ts`, the target of `createBulk`'s returned function
  gains:

```ts
    /**
     * Called when a bulkWrite() or output() made on this target is abandoned
     * by its own signal or timeout. A transaction passes one, because an
     * abandoned write abandons the transaction (spec 2026-09-10, R1) and this
     * signal exists only in here; the client path passes none.
     */
    onAbandoned?: (cause: unknown) => void;
```

  and destructures it beside `read`, `write`, `transaction`. In `bulkWrite`, right after
  `signal?.addEventListener('abort', releaseRoom, { once: true });`:

```ts
      // A transaction's bulkWrite is one of its writes: abandoning it abandons
      // the transaction, even between batches, where no statement is in flight
      // to say so. A signal already aborted never fires `abort`, hence the
      // direct call. output() is covered too: it hands its signal to this.
      const abandon = () => onAbandoned?.(signal?.reason);
      if (onAbandoned && signal) {
        if (signal.aborted) abandon();
        else signal.addEventListener('abort', abandon, { once: true });
      }
```

  and in `close()`'s `finally`, beside the `releaseRoom` removal:
  `signal?.removeEventListener('abort', abandon);`. In `src/transaction.ts`, the
  `deps.bulkFor({...})` target gains `onAbandoned: (cause) => die(cause),`.

- [ ] **Step 4: Run green, then the falsifier.** `pnpm check`, `tsc`, `pnpm test` —
  `tests/browser/tx-write.test.ts`, `bulk-write.test.ts` and `multi-client.test.ts` must stay
  green unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/bulk.ts src/transaction.ts tests/browser/tx-abort.test.ts
git commit   # fix(transaction): an abandoned tx.bulkWrite or tx.output abandons it
```

---

### Task 5: `tx.signal` (R8, D10, D11)

**Files:**
- Modify: `src/api.ts` (`SQLiteTransactionDB`), `src/transaction.ts` (the `db` literal)
- Test: `tests/browser/tx-handle.test.ts`

**Interfaces:**
- Consumes: `signal` (Task 3, typed `AbortSignal`).
- Produces: `SQLiteTransactionDB['signal']: AbortSignal`.

- [ ] **Step 1: Browser tests** (spec §8 test 11), appended to `tx-handle.test.ts`:

```ts
describe('tx.signal', () => {
  // Falsifiable: expose `outer` instead of the merged signal; the death
  // controller never reaches it and this stays un-aborted.
  it('aborts with the write reason when an abandoned write kills the transaction', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const reason = new Error('abandon the write');
      const ctl = new AbortController();
      ctl.abort(reason);
      let seen!: AbortSignal;
      await expect(
        db.transaction(async (tx) => {
          seen = tx.signal;
          await tx.write('INSERT INTO t VALUES (1)', [], { signal: ctl.signal }).catch(() => {});
        }),
      ).rejects.toBe(reason);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
    } finally {
      await db.close();
    }
  });

  it('aborts with OPERATION_TIMEOUT when the transaction outlives its timeout', async () => {
    const db = await createTestClient({ poolSize: 1 });
    try {
      let seen!: AbortSignal;
      await expect(
        db.transaction(
          async (tx) => {
            seen = tx.signal;
            // Work that is not a statement, stopped by the signal it was handed.
            await new Promise<void>((resolve) =>
              tx.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          },
          { timeout: 100 },
        ),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  // Falsifiable: drop `releaseDeath()` from transaction.ts's outer finally; the
  // later close() then aborts a signal whose transaction ended long ago. (Not
  // `releaseClose()`: with no transaction signal or timeout, mergeSignals
  // returns closeSignal itself and that release is a no-op.)
  it('is not aborted by a normal end, an explicit commit, or a later close()', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await db.write('CREATE TABLE t (a INTEGER)');
    let seen!: AbortSignal;
    let afterCommit: boolean | undefined;
    await db.transaction(
      async (tx) => {
        seen = tx.signal;
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.commit();
        afterCommit = tx.signal.aborted;
      },
      { autoCommit: false },
    );
    expect(afterCommit).toBe(false);
    expect(seen.aborted).toBe(false);
    await db.close();
    expect(seen.aborted).toBe(false);
  });
});
```

- [ ] **Step 2: Run and see them fail** (`tx.signal` is `undefined`; the type check fails first
  — that is the red for the type, run the browser file after adding the type alone to see the
  runtime red).

- [ ] **Step 3: Implement.** In `src/api.ts`, `SQLiteTransactionDB` becomes:

```ts
export type SQLiteTransactionDB = SQLiteQueryAPI & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  /**
   * Aborted when this transaction is abandoned — by its own `signal` or
   * `timeout`, by `close()`, or because a write in it was abandoned — with the
   * reason `transaction()` rejects with. Never aborted by a normal end. Hand
   * it to work of your own the callback awaits, such as a `fetch`, so that
   * work stops with the transaction.
   */
  readonly signal: AbortSignal;
};
```

  In `src/transaction.ts`, add `signal,` to the `db` object literal, with the comment:
  `// The merged signal itself (spec §4): it aborts on every cause of death with the cause as
  reason, and the outer finally only detaches it, so a normal end leaves it un-aborted for good.
  The death controller is never exposed — the consumer can listen, not abort.`

- [ ] **Step 4: Run green, then the falsifiers.** `pnpm check`, `tsc`, `pnpm test`.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts src/transaction.ts tests/browser/tx-handle.test.ts
git commit   # feat(transaction): tx.signal stops the callback's own work
```

---

### Task 6: Documentation (spec §9)

**Files:** `API.md`, `CHANGELOG.md`

Consumer documentation is edited iteratively with the user (`mem:conventions`): draft these
edits, show the diff, and commit only once the user has approved the wording. No measurements,
no mechanism — state what the consumer sees and what it costs them.

- [ ] **Step 1: `API.md`, *Inside a transaction*.** In **An abort reaches further than a
  statement.**, `but every statement it issues afterwards rejects` becomes `but every statement
  it issues afterwards rejects with `TRANSACTION_CLOSED``. Replace the paragraph step 1 added
  (**A statement's own `signal` or `timeout` rejects only that statement.** …) with:

~~~markdown
**An abandoned write abandons its transaction; an abandoned read does not.** A statement's own `signal` or `timeout` rejects that statement with its own reason. If the statement only reads, that is all: caught, the callback continues and can still commit. If it writes — `write()`, `bulkWrite()`, `output()`, or any statement that is not a plain read — the whole transaction is abandoned with it, even when the callback catches the rejection: `transaction()` rejects with that same reason and nothing the transaction wrote is kept. A write that rejects has no effect.

**A transaction object is closed once its transaction is over** — committed, rolled back or abandoned. Any statement issued on it afterwards rejects with `TRANSACTION_CLOSED` without reaching the database; its `cause` is the reason the transaction was abandoned, and is absent after a commit or a rollback. `commit()` resolves if the transaction committed and rejects otherwise. `rollback()` always resolves, and warns in the console when the transaction had already committed.

**`tx.signal` stops your own work with the transaction.** It aborts when the transaction is abandoned, with the reason `transaction()` rejects with, and never when it ends normally. Hand it to anything the callback awaits that is not a statement:

```typescript
await db.transaction(async (tx) => {
  const rows = await tx.read('SELECT …');
  const priced = await fetch(url, { signal: tx.signal });
  await tx.write('INSERT …', [priced]);
});
```
~~~

- [ ] **Step 2: `API.md`, *client*.transaction** — wherever the transaction object's members
  are listed or described, add `signal` beside `commit()` and `rollback()` with one sentence
  pointing to *Inside a transaction*. **`API.md`, *Error handling*:** add after
  `READ_ONLY_TRANSACTION`:

```markdown
| `TRANSACTION_CLOSED` | A statement, `commit()`, `bulkWrite()` or `output()` was used on a transaction object whose transaction is over. `error.cause` is the reason the transaction was abandoned; it is absent when the transaction committed or rolled back. |
```

- [ ] **Step 3: `CHANGELOG.md`, `## Unreleased`.** Under `### Breaking`:

```markdown
- **A statement issued in an abandoned transaction rejects with `TRANSACTION_CLOSED`.** After
  the transaction's `signal` fired, a statement its callback issued rejected with
  `signal.reason`; it now rejects with `TRANSACTION_CLOSED`, carrying that reason as `cause`.
  `transaction()` itself still rejects with `signal.reason`.
```

  Under `### Added`:

```markdown
- **`TRANSACTION_CLOSED`**, the error a transaction object raises once its transaction is over.
- **`tx.signal`**, aborted when the transaction is abandoned, for the callback to hand to work
  of its own.
```

  Under `### Fixed`, in the step 1 entry (**A statement's own `timeout` inside a
  `transaction()` now bounds it.**), replace everything from `A per-statement `timeout` now
  rejects that statement alone` to the end of the entry with `A per-statement `timeout` now
  aborts its statement with `OPERATION_TIMEOUT`, exactly as a per-statement `signal` does.` —
  its old wording said a caught one lets the callback continue, which is false for a write.
  Then add:

```markdown
- **An abandoned write could leave the rest of a transaction outside it.** Where a running
  statement can be interrupted, SQLite rolls the whole transaction back when a write is
  interrupted, and the callback went on in autocommit: statements that followed were committed
  one by one while the transaction reported failure. Where it cannot, the abandoned write ran
  to its end and was committed although its caller received a rejection. An abandoned write now
  abandons its transaction on every build, and a rejected write never has an effect.
- **Interrupting a write inside a transaction no longer costs a worker** — nor, on a memory
  VFS, the whole database, which the replacement worker opened empty.
- **A transaction object used after its transaction ended could reach another transaction.**
  A late `rollback()` rolled back whatever transaction ran next on the same connection, and a
  late write joined it. Such calls now reject with `TRANSACTION_CLOSED` — or, for
  `rollback()`, resolve without doing anything — and never reach the database.
```

- [ ] **Step 4: Show the diff to the user; apply their corrections; commit on approval.**

```bash
git add API.md CHANGELOG.md
git commit   # docs: an abandoned write abandons its transaction; a closed handle refuses
```

---

## After the last task

A whole-branch review (capable tier) over `main..HEAD`, which includes step 1's commit and the
spec commits. Then the closure procedure of `mem:conventions` — merge `--no-ff`, memories
(`mem:state`, `mem:architecture` for the ending state and `PoolWorker.inTransaction`,
`mem:measurements` for §1's campaigns and M1, `mem:follow-ups` for the `SQLITE_FULL` code
observation), commit, branch deletion — only when the user says so.
