# A caught write abort leaves the transaction whole — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `tx` statement abandoned by its own `signal`/`timeout` while it runs has no effect, and a callback that catches it goes on inside the transaction.

**Architecture:** The worker runs a savepoint inside the write's own message and leaves it open; the transaction's NEXT message concludes it (`RELEASE`, or `ROLLBACK TO` + `RELEASE` when the write was abandoned). A savepointed write is driven by the transaction's signal only, so only a death cuts it; its caller races its own signal and is rejected at once while the write runs on. Every entry point waits for an abandoned write before sending anything.

**Tech Stack:** TypeScript, wa-sqlite in Web Workers, rstest (unit project in Node; browser projects on Chromium and Firefox via Playwright; an isolated Chromium project), biome.

**Spec:** `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md` — read it whole before Task 1. The rules are R1-R4 (§3), the mechanism §4, the decisions D1-D9 (§2).

## Global Constraints

- **Serena for code** (`AGENTS.md`): read code with `get_symbols_overview` / `find_symbol`, edit with `replace_symbol_body` / `insert_*_symbol` / `replace_content`. Built-in Read/Edit only on non-code files or when Serena fails.
- **Never** `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`.
- Before every commit: `pnpm check` (biome, writes fixes), then `pnpm exec tsc --noEmit` — must be clean. If the pre-commit hook fails, stop and report its output verbatim. After committing: `git log --oneline -1` and `git show --stat HEAD`.
- **Every commit lands green.** The pre-commit hook runs only `tsc`, lint-staged and the unit project. Each task therefore also runs, before its commit, every browser file it touches on BOTH engines: `pnpm exec rstest run --project chromium <file-pattern>` and `pnpm exec rstest run --config rstest.firefox.config.ts <file-pattern>`; and the isolated project where named: `pnpm exec rstest run --config rstest.isolated.config.ts <file-pattern>`. Unit: `pnpm exec rstest run --project unit <file-pattern>`.
- **Read four fields from a test report**: `status` and `failedFiles` as well as the test counts — an unhandled rejection escaping a test shows only there.
- The library's savepoint is named `__bsq_sp`, fixed (D7). The type `SavepointOp` is internal: never re-exported from `src/index.ts`.
- English everywhere in code, comments, tests and commits. Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Do not accept "pre-existing" for a failure without checking it on the base commit (`git stash` is forbidden; use a clean worktree: `git worktree add ../wsqlite-base HEAD~N`).

## File map

| File | Change |
|---|---|
| `src/types.ts` | `SavepointOp`; `SQLOptions.savepoint` (Task 2) |
| `src/pool.ts` | `PoolWorkerQueryOptions.savepoint` thunk, read just before `postMessage` (Task 2) |
| `src/worker/worker.ts` | `LIBRARY_SAVEPOINT`; the `query` case runs conclude/open before the statement (Task 2) |
| `src/transaction.ts` | the facade `via`, `pending`, `abandoned`, `entryWait`, `abandon`, `opensSavepoint`; new `withSignal`/`settled`; `releasing` (Tasks 3-6) |
| `src/bulk.ts` | `onAbandoned` deleted (Task 5) |
| `src/utils.ts` | `isTransactionControl` (Task 6) |
| `tests/browser/tx-savepoint.test.ts` | new: T1-T11 browser tests (Tasks 1, 3, 4, 5, 6) |
| `tests/browser/isolated/tx-savepoint.test.ts` | new: the `sync` isolated build (Task 3) |
| `tests/browser/pool-savepoint.test.ts` | new: the worker protocol through `createPoolWorker` (Task 2) |
| `tests/browser/tx-abort.test.ts` | seven tests invert (Tasks 3, 5) |
| `tests/unit/transaction.test.ts` | fake worker honours `savepoint`; T7; two tests change, one inverts (Tasks 3, 4, 6) |
| `tests/unit/utils.test.ts` | `isTransactionControl` (Task 6) |
| `API.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-10-transaction-abort-design.md` | Task 7 |

---

### Task 1: Pin what must not move — a caught SQL error, and a connection that leaves (T10, T11)

Tests only. Both pass on the current code; they exist so that Tasks 3-6 cannot silently change them.

**Files:**
- Create: `tests/browser/tx-savepoint.test.ts`

**Interfaces:**
- Produces: the file's shared helpers — `deferred`, `BIG_INSERT`, `workerIdentity`, `abortAfter`, `setUp`, `rowsOf`, `bigCount`, `timed` — which Tasks 3, 4, 5 and 6 append tests to.

- [ ] **Step 1: Create the file with its helpers and the two tests**

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from './helpers';

/**
 * docs/superpowers/specs/2026-09-11-tx-savepoint-design.md: a statement the
 * callback catches has no effect, and the transaction goes on (R1-R4).
 */

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * One INSERT whose single step() runs for hundreds of milliseconds (Chromium)
 * to seconds (Firefox), so an abort at 30 ms lands inside it.
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

const setUp = async (options: {
  vfs: 'MemoryVFS' | 'OPFSAdaptiveVFS';
  build?: 'sync' | 'async';
}) => {
  const db = await createTestClient({ ...options, poolSize: 1, debug: true });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  await db.write('INSERT INTO t VALUES (0)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

const bigCount = async (db: Db) =>
  (await db.read<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n;

/** Milliseconds `fn` takes. */
const timed = async (fn: () => Promise<unknown>) => {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
};

describe('an SQL error the callback catches (spec 2026-09-11 §1)', () => {
  // The first row of the spec's §1 table, which no test covered. Falsifiable:
  // in src/transaction.ts's `settled`, call die(e) in the catch for every
  // rejection — the caught violation then kills the transaction and
  // INSERT (2) never lands.
  it('lets the transaction go on and commit what preceded it (T11)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      await db.write('CREATE UNIQUE INDEX t_a ON t (a)');
      let caught: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        caught = await tx.write('INSERT INTO t VALUES (1)').catch((e) => e);
        await tx.write('INSERT INTO t VALUES (2)');
      });
      expect((caught as Error).message).toMatch(/UNIQUE/);
      expect(await rowsOf(db)).toEqual([0, 1, 2]);
    } finally {
      await db.close();
    }
  });

  // D6 of the 2026-09-10 spec, in a browser for the first time — only the fake
  // worker of tests/unit/transaction.test.ts pinned it. Falsifiable: remove the
  // dieIfConnectionLeft() call from `settled` — the SELECT then runs in
  // autocommit and `later` holds its rows.
  it('dies when ON CONFLICT ROLLBACK takes the transaction with it (T10)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      await db.write('CREATE UNIQUE INDEX t_a ON t (a)');
      const before = workerIdentity(db);
      let caught: unknown;
      let later: unknown;
      const finished = deferred();
      const outcome = await db
        .transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await tx
            .write('INSERT OR ROLLBACK INTO t VALUES (1)')
            .catch((e) => e);
          later = await tx.read('SELECT a FROM t').catch((e) => e);
          finished.resolve();
        })
        .catch((e) => e);
      await finished.promise;

      expect(outcome).toBe(caught);
      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((later as Error).cause).toBe(caught);
      expect(await rowsOf(db)).toEqual([0]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  });
});
```

Helpers not used until later tasks (`BIG_INSERT`, `abortAfter`, `bigCount`, `timed`) will trip biome's unused-variable rule. If `pnpm lint` reports them, prefix each with a one-line `// Used by the savepoint tests below.` and add them in the task that first uses them instead — do not disable the rule.

- [ ] **Step 2: Run on both engines — expected PASS (these pin current behaviour)**

Run: `pnpm exec rstest run --project chromium tx-savepoint` then `pnpm exec rstest run --config rstest.firefox.config.ts tx-savepoint`
Expected: `status: pass`, `failedFiles: 0`, 2 tests each.

- [ ] **Step 3: Verify both falsifiers**

Apply each mutation named in the comments to `src/transaction.ts`, rerun the chromium command, confirm the named test FAILS, undo the mutation by hand, confirm `git diff -- src` is empty.

- [ ] **Step 4: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add tests/browser/tx-savepoint.test.ts
git commit -m "test(transaction): pin a caught SQL error, and a connection that leaves, in a browser

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: The worker protocol — conclude, then open, before the statement

**Files:**
- Modify: `src/types.ts` (`SQLOptions`, new `SavepointOp`)
- Modify: `src/pool.ts` (`PoolWorkerQueryOptions`, `runQuery` just before its `worker.postMessage({ type: 'query', … })`)
- Modify: `src/worker/worker.ts` (module constant; the `case 'query'` of the opened database's `self.onmessage`)
- Create: `tests/browser/pool-savepoint.test.ts`

**Interfaces:**
- Produces: `export type SavepointOp = { conclude?: 'release' | 'undo'; open?: true }` in `src/types.ts`; `PoolWorkerQueryOptions.savepoint?: (() => SavepointOp | undefined) | undefined`, called by the pool exactly once, only for a query it posts.

- [ ] **Step 1: Write the failing test**

Create `tests/browser/pool-savepoint.test.ts`:

```ts
import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createLogger } from '../../src/logger';
import {
  createPoolWorker,
  type PoolWorker,
  type PoolWorkerQueryOptions,
} from '../../src/pool';
import { defaultBuildFor } from '../../src/types';

/**
 * The worker half of the savepoint protocol (spec 2026-09-11, §4), reached
 * through `createPoolWorker` directly, as tests/browser/abandon.test.ts does:
 * no transaction.ts is involved, so what is pinned is the worker's order of
 * operations and the moment the pool reads the thunk, nothing above.
 */
const spawn = () =>
  createPoolWorker({
    index: 0,
    pool: [] as (PoolWorker | undefined)[],
    clientName: 'pool-savepoint',
    // Short: sqlite3_open_v2 refuses a name near the VFS's 64-byte path budget.
    file: `psp-${Date.now().toString(36)}`,
    vfs: 'MemoryVFS',
    build: defaultBuildFor('MemoryVFS'),
    drainTimeout: 5000,
    logger: createLogger('test', false),
  });

const run = async (
  worker: PoolWorker,
  sql: string,
  options?: PoolWorkerQueryOptions,
) => {
  const rows: unknown[] = [];
  for await (const chunk of worker.query(sql, [], options))
    if (typeof chunk !== 'number') rows.push(...chunk);
  return rows;
};

describe('the worker concludes, then opens, a savepoint before the statement', () => {
  // Falsifiable: drop the `ROLLBACK TO` line in src/worker/worker.ts — row 2
  // is then committed.
  it('undoes the savepointed statement when the next message says undo', async () => {
    const worker = await spawn();
    try {
      await run(worker, 'CREATE TABLE t (a INTEGER)');
      await run(worker, 'BEGIN');
      await run(worker, 'INSERT INTO t VALUES (1)');
      await run(worker, 'INSERT INTO t VALUES (2)', {
        savepoint: () => ({ open: true }),
      });
      await run(worker, 'INSERT INTO t VALUES (3)', {
        savepoint: () => ({ conclude: 'undo' }),
      });
      await run(worker, 'COMMIT');
      expect(await run(worker, 'SELECT a FROM t ORDER BY a')).toEqual([
        { a: 1 },
        { a: 3 },
      ]);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });

  // Falsifiable: drop the `RELEASE` line — the savepoint survives and the
  // ROLLBACK TO below succeeds instead of failing.
  it('keeps the statement, and closes the savepoint, when the next message says release', async () => {
    const worker = await spawn();
    try {
      await run(worker, 'CREATE TABLE t (a INTEGER)');
      await run(worker, 'BEGIN');
      await run(worker, 'INSERT INTO t VALUES (1)');
      await run(worker, 'INSERT INTO t VALUES (2)', {
        savepoint: () => ({ open: true }),
      });
      await run(worker, 'SELECT 1', {
        savepoint: () => ({ conclude: 'release' }),
      });
      const refused = await run(worker, 'ROLLBACK TO __bsq_sp').catch((e) => e);
      expect((refused as Error).message).toMatch(/no such savepoint/);
      await run(worker, 'COMMIT');
      expect(await run(worker, 'SELECT a FROM t ORDER BY a')).toEqual([
        { a: 1 },
        { a: 2 },
      ]);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });

  // Falsifiable: in src/pool.ts's runQuery, call `savepoint?.()` above the
  // reuse guard — it is then read for a query the guard refuses, and a
  // transaction would lose its pending conclusion to it.
  it('reads the thunk only for a query it actually sends', async () => {
    const worker = await spawn();
    try {
      // Held mid-query: one row delivered, the worker parked on its credit.
      const held = worker.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x FROM c',
        [],
        { chunkSize: 1, credits: 1 },
      );
      await held.next();
      let read = false;
      const refused = await worker
        .query('SELECT 1', [], {
          savepoint: () => {
            read = true;
            return { open: true };
          },
        })
        .next()
        .catch((e) => e);
      expect(refused).toBeInstanceOf(SQLiteError);
      expect((refused as SQLiteError).code).toBe('GENERATOR_ABANDONED');
      expect(read).toBe(false);
      worker.interrupt(held);
      await held.return(undefined);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });
});
```

- [ ] **Step 2: Run it — expected FAIL**

Run: `pnpm exec rstest run --project chromium pool-savepoint`
Expected: FAIL — `tsc` will also flag `savepoint` as unknown on `PoolWorkerQueryOptions`; the first test sees `[1, 2, 3]`.

- [ ] **Step 3: `src/types.ts`**

Directly above `type SQLOptions`, add:

```ts
/**
 * The savepoint a transaction asks the worker to handle around one query
 * (spec 2026-09-11, D4/D5). `conclude` settles the savepoint the previous
 * savepointed write left open — `release` keeps that write, `undo` rolls it
 * back first — and `open` starts one for this query's own statement. Both run
 * before the statement, conclusion first. Internal: no consumer sets it.
 */
export type SavepointOp = { conclude?: 'release' | 'undo'; open?: true };
```

and add to `SQLOptions`, after `abortable`:

```ts
  /** See `SavepointOp`. */
  savepoint?: SavepointOp;
```

- [ ] **Step 4: `src/pool.ts`**

Add `SavepointOp` to the existing type import from `./types`. Add to `PoolWorkerQueryOptions`, after `noServed`:

```ts
  /**
   * Read exactly once, when the query is POSTED — below the reuse guard,
   * never when the query is created. A transaction hands its pending savepoint
   * conclusion over in here, so a query the guard refuses must not consume it
   * (spec 2026-09-11, §4).
   */
  savepoint?: (() => SavepointOp | undefined) | undefined;
```

In `runQuery`, add `savepoint` to the destructuring of `options ?? {}`, and replace the `worker.postMessage({ type: 'query', … })` call with:

```ts
      // Read here and nowhere earlier: the reuse guard above has admitted this
      // query, so a transaction's pending conclusion leaves only with a message
      // that is actually sent (spec 2026-09-11, §4).
      const op = savepoint?.();
      worker.postMessage({
        type: 'query',
        callId: ++currentCallId,
        sql,
        params,
        options: {
          chunkSize,
          credits,
          timeout,
          abortable,
          ...(op ? { savepoint: op } : {}),
        },
      });
```

- [ ] **Step 5: `src/worker/worker.ts`**

Below `const PROGRESS_OPS = 100_000;` add:

```ts
/**
 * The one savepoint this library opens inside a transaction (spec 2026-09-11,
 * D7). One at a time — the next message concludes it before anything else —
 * so a fixed name suffices, and its three statements stay in the statement
 * cache. A consumer's own savepoints never sit above it.
 */
const LIBRARY_SAVEPOINT = '__bsq_sp';
```

In the opened database's `self.onmessage`, `case 'query'`, directly after `let affected = 0;` and before the `for await (const chunk of query(…))` loop, add:

```ts
          // Spec 2026-09-11, D5: conclude the savepoint the previous
          // savepointed write left open, then open this statement's own —
          // before the statement, in that order. Through `query` itself so they
          // take the statement cache; `prepared` is reset after them so the
          // reply describes the caller's statement alone. A failure here is this
          // query's `error`, reported below like any other.
          const savepoint = options?.savepoint;
          if (savepoint) {
            const control = async (statement: string) => {
              for await (const _ of query(callId, statement, [])) {
                // Savepoint statements return no rows.
              }
            };
            if (savepoint.conclude === 'undo')
              await control(`ROLLBACK TO ${LIBRARY_SAVEPOINT}`);
            if (savepoint.conclude)
              await control(`RELEASE ${LIBRARY_SAVEPOINT}`);
            if (savepoint.open) await control(`SAVEPOINT ${LIBRARY_SAVEPOINT}`);
            prepared = 0;
          }
```

- [ ] **Step 6: Run — expected PASS on both engines, and nothing else moves**

Run: `pnpm exec rstest run --project chromium pool-savepoint abandon` and `pnpm exec rstest run --config rstest.firefox.config.ts pool-savepoint abandon`
Expected: `status: pass`, `failedFiles: 0`. Then `pnpm exec rstest run --project unit` — 432 tests, pass.

- [ ] **Step 7: Verify the three falsifiers** as in Task 1, Step 3.

- [ ] **Step 8: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/types.ts src/pool.ts src/worker/worker.ts tests/browser/pool-savepoint.test.ts
git commit -m "feat(worker): conclude and open a transaction's savepoint before its statement

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The transaction — a promise statement abandoned by its own signal is undone, and the callback goes on

The core of the design, for `read`/`write`/`first` and the bulk target's `read`/`write`. Generator statements keep the old rule until Task 4, `bulkWrite`/`output` until Task 5.

**Files:**
- Modify: `src/transaction.ts`
- Modify: `tests/unit/transaction.test.ts`
- Modify: `tests/browser/tx-abort.test.ts`
- Modify: `tests/browser/tx-savepoint.test.ts`
- Create: `tests/browser/isolated/tx-savepoint.test.ts`

**Interfaces:**
- Consumes: `SavepointOp`, `PoolWorkerQueryOptions.savepoint` (Task 2).
- Produces, inside `createTransaction` (Tasks 4-6 use them): `pending`, `abandoned`, `via(open, mark?)`, `entryWait(waiting)`, `abandon(running, method)`, `opensSavepoint(sql, own, abortedAtCall)`, and `withSignal(given, method, sql)` returning `{ options, driving, release, settled, own, abortedAtCall, savepointed, mark }` where `settled: <R>(start: (target: PoolWorker, options: O) => Promise<R>) => Promise<R>`.

- [ ] **Step 1: Teach the unit fake worker the protocol**

In `tests/unit/transaction.test.ts`, replace the fake's `query` signature and first line so it records what the real worker would run:

```ts
    query: async function* (
      sql: string,
      _params?: unknown[],
      options?: {
        savepoint?: () =>
          | { conclude?: 'release' | 'undo'; open?: true }
          | undefined;
      },
    ) {
      // As the real worker (spec 2026-09-11, §4): the conclusion, then the
      // open, then the statement — all recorded, so `executed` is every
      // statement the connection ran.
      const savepoint = options?.savepoint?.();
      if (savepoint?.conclude === 'undo') executed.push('ROLLBACK TO __bsq_sp');
      if (savepoint?.conclude) executed.push('RELEASE __bsq_sp');
      if (savepoint?.open) executed.push('SAVEPOINT __bsq_sp');
      executed.push(sql);
```

(the rest of the body — `fails`, hooks, `yield`, the `finally` — is unchanged). Update the doc comment above `fakeWorker` with one sentence: "It honours `options.savepoint` the way the real worker does, recording the savepoint statements in `executed`."

- [ ] **Step 2: Write the failing unit tests**

(a) In *the caller may abandon it*, *still honours a statement signal, with its own reason*: the write now runs inside a savepoint. Change its expected list to:

```ts
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
```

(b) In *what else kills it (spec R1)*, replace the test *dies when a write is abandoned by its own signal, and rolls back what is open (R5)* with:

```ts
  // Spec 2026-09-11, R1. Falsifiable: in src/transaction.ts's `abandon`, drop
  // `pending = 'undo'` — the next message then releases the abandoned write
  // instead of rolling it back.
  it('rolls back a write abandoned by its own signal, and the transaction goes on', async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this write only');
    let caught: unknown;
    await transaction(async (tx) => {
      const pending = tx.write('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(reason);
      caught = await pending.catch((e) => e);
      gate.resolve();
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });
```

(c) Append a new `describe` at the end of the file:

```ts
describe('transaction — a savepointed write, and the message after it (spec 2026-09-11)', () => {
  /** A write abandoned by its own signal, then `entry`: the statements run. */
  const abandonedThen = async (
    entry: (tx: SQLiteTransactionDB) => Promise<unknown>,
  ) => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this write only');
    let caught: unknown;
    await transaction(async (tx) => {
      const write = tx.write('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(reason);
      caught = await write.catch((e) => e);
      gate.resolve();
      await entry(tx);
    });
    expect(caught).toBe(reason);
    return worker.executed;
  };

  // T7. Falsifiable, each: have that one method call its query helper with the
  // raw `worker` instead of `via(…)` — its first message then carries no
  // conclusion, and the abandoned write would be committed.
  const entries: [
    string,
    (tx: SQLiteTransactionDB) => Promise<unknown>,
    string,
  ][] = [
    ['read', (tx) => tx.read('SELECT 2'), 'SELECT 2'],
    ['write', (tx) => tx.write('INSERT INTO t VALUES (2)'), 'INSERT INTO t VALUES (2)'],
    ['first', (tx) => tx.first('SELECT 2'), 'SELECT 2'],
    [
      'chunk',
      async (tx) => {
        for await (const _rows of tx.chunk('SELECT 2')) {
          // drain it
        }
      },
      'SELECT 2',
    ],
    [
      'stream',
      async (tx) => {
        for await (const _row of tx.stream('SELECT 2')) {
          // drain it
        }
      },
      'SELECT 2',
    ],
    ['commit', (tx) => tx.commit(), 'COMMIT'],
  ];
  for (const [name, entry, sql] of entries) {
    it(`${name}() concludes the abandoned write's savepoint, with an undo, first`, async () => {
      const executed = await abandonedThen(entry);
      expect(executed.slice(0, 6)).toEqual([
        'BEGIN',
        'SAVEPOINT __bsq_sp',
        'INSERT INTO t VALUES (1)',
        'ROLLBACK TO __bsq_sp',
        'RELEASE __bsq_sp',
        sql,
      ]);
    });
  }

  // Falsifiable: send rollbackNow()'s ROLLBACK through `via(false)` — it then
  // carries the undo, and ROLLBACK TO precedes it.
  it('rollback() concludes nothing: a full ROLLBACK discards every savepoint', async () => {
    const executed = await abandonedThen((tx) => tx.rollback());
    expect(executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });

  // Falsifiable: in `via`, set `pending = undefined` when a query opens a
  // savepoint — the savepoint is then never released.
  it('releases a savepointed write that completed, with the next message', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.write('INSERT INTO t VALUES (1)', [], { timeout: 60_000 });
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });

  // R2. Falsifiable: in `entryWait`, await `abandoned` without racing the
  // waiting statement's signal — the second write then waits for the gate,
  // runs and resolves.
  it("rejects a statement whose own signal fires while it waits, alone", async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const second = new AbortController();
    const reason = new Error('the second write only');
    let refused: unknown;
    await transaction(async (tx) => {
      const write = tx.write('INSERT INTO t VALUES (1)', [], {
        signal: own.signal,
      });
      await reached.promise;
      own.abort(new Error('the first write only'));
      await write.catch(() => {});
      const waiting = tx.write('INSERT INTO t VALUES (2)', [], {
        signal: second.signal,
      });
      second.abort(reason);
      setTimeout(() => gate.resolve(), 50);
      refused = await waiting.catch((e) => e);
      await tx.write('INSERT INTO t VALUES (3)');
    });
    expect(refused).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (3)',
      'COMMIT',
    ]);
  });

  // Falsifiable: send the teardown's ROLLBACK through `via(false)` — it then
  // carries the pending undo.
  it('sends the teardown ROLLBACK with no conclusion', async () => {
    const reached = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1)': async () => {
        reached.resolve();
        await never();
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const failure = new Error('give up');
    await expect(
      transaction(async (tx) => {
        const write = tx.write('INSERT INTO t VALUES (1)', [], {
          signal: own.signal,
        });
        await reached.promise;
        own.abort(new Error('this write only'));
        await write.catch(() => {});
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK',
    ]);
  });
});
```

- [ ] **Step 3: Run the unit tests — expected FAIL**

Run: `pnpm exec rstest run --project unit transaction`
Expected: FAIL — no `SAVEPOINT __bsq_sp` in any list; the inverted test sees the transaction die.

- [ ] **Step 4: Implement in `src/transaction.ts`**

4.1 — Imports: `import type { PoolWorker, PoolWorkerQueryOptions } from './pool';` (replacing the `PoolWorker`-only import).

4.2 — Directly after `let begun = false;` add:

```ts
      /**
       * The conclusion owed to the savepoint the last savepointed write left
       * open (spec 2026-09-11, D5). The next message the transaction sends
       * carries it, and the worker runs it before anything else: `release`
       * keeps that write, `undo` rolls it back because its own signal abandoned
       * it. Undefined when no library savepoint is open.
       */
      let pending: 'release' | 'undo' | undefined;
      /**
       * Settles once a write abandoned by its own signal has ended on the
       * worker and been judged (spec 2026-09-11, R2). Every entry point waits
       * for it: nothing may reach the worker while that write still runs.
       * Never rejects.
       */
      let abandoned: Promise<void> | undefined;
```

4.3 — `commitNow` sends through the facade; `rollbackNow` does not. Replace their first lines:

```ts
      const commitNow = async () => {
        await exec(via(false), 'COMMIT');
```

```ts
      const rollbackNow = async () => {
        // Straight to the worker, never through `via`: a full ROLLBACK
        // discards every savepoint, so there is nothing to conclude — and a
        // RELEASE sent to a connection that already left its transaction would
        // fail and evict a healthy worker (spec 2026-09-11, §4).
        pending = undefined;
        await exec(worker, 'ROLLBACK');
```

4.4 — Delete `owesWait` and its doc comment. In its place add:

```ts
      /**
       * The worker as one statement sees it (spec 2026-09-11, D9). Its `query`
       * hands the pool a thunk the pool reads only when it POSTS the query —
       * below the reuse guard — so a refused statement neither consumes the
       * pending conclusion nor claims a savepoint; and `mark` learns that the
       * statement reached the worker, which is what owes the idle wait (it
       * replaces `owesWait`: a statement the guard refused was never posted).
       * Everything else is the worker itself, through the prototype: the query
       * helpers call `query` and `interrupt`, and `interrupt` compares
       * transports by identity, which this leaves untouched.
       */
      const via = (open: boolean, mark?: { posted: boolean }): PoolWorker => {
        const facade: PoolWorker = Object.create(worker);
        facade.query = ((
          sql: string,
          params?: unknown[],
          options?: PoolWorkerQueryOptions,
        ) =>
          worker.query(sql, params, {
            ...options,
            savepoint: () => {
              if (mark) mark.posted = true;
              const conclude = pending;
              pending = open ? 'release' : undefined;
              if (!conclude && !open) return undefined;
              return {
                ...(conclude ? { conclude } : {}),
                ...(open ? { open: true as const } : {}),
              };
            },
          })) as PoolWorker['query'];
        return facade;
      };

      /**
       * R2 (spec 2026-09-11): a statement issued after a write abandoned by its
       * own signal waits until that write has ended and been judged. `waiting`
       * is the statement's merged signal: its own abort rejects it alone — it
       * has not reached the database — and the transaction's rejects it with
       * the cause. Call it only when `abandoned` is set, so that the common
       * path posts synchronously, as it always has.
       */
      const entryWait = async (waiting: AbortSignal | undefined) => {
        const current = abandoned;
        if (!current) return;
        // B9: addEventListener never fires for a signal already aborted.
        waiting?.throwIfAborted();
        const { aborted, teardown } = makeAbortRace(waiting);
        try {
          await (aborted ? Promise.race([current, aborted]) : current);
        } finally {
          teardown();
        }
        if (ending) throw closedError(ending);
      };

      /**
       * The write was abandoned by its own signal while it ran (spec
       * 2026-09-11, R1). It runs on, driven by the transaction's signal alone;
       * the next message rolls it back, and every entry point waits for it. If
       * the connection left the transaction meanwhile, the transaction dies as
       * after any statement (spec 2026-09-10, D6).
       */
      const abandon = (running: Promise<unknown>, method: string) => {
        pending = 'undo';
        const judged: Promise<void> = running
          .then(
            () => ({ failed: false, error: undefined as unknown }),
            (error: unknown) => ({ failed: true, error }),
          )
          .then(async ({ failed, error }) => {
            await worker.quiesce();
            dieIfConnectionLeft(failed, error, method);
          })
          .catch(() => {
            // Judging must never reject: every entry point awaits this, and
            // the caller already has its rejection.
          })
          .finally(() => {
            if (abandoned === judged) abandoned = undefined;
          });
        abandoned = judged;
      };

      /**
       * Whether a statement runs inside the library's savepoint (spec
       * 2026-09-11, R1): a write the caller may abandon alone — it carries its
       * own signal or timeout, not already aborted at the call. Only those pay
       * (D4).
       */
      const opensSavepoint = (
        sql: string,
        own: AbortSignal | undefined,
        abortedAtCall: boolean,
      ) => own !== undefined && !abortedAtCall && isWriteQuery(sql);
```

4.5 — Replace `withSignal` (body and return type) with:

```ts
      const withSignal = <
        O extends {
          signal?: AbortSignal | undefined;
          timeout?: number | undefined;
        },
      >(
        given: O | undefined,
        method: string,
        sql: string,
      ): {
        options: O;
        driving: O;
        release: () => void;
        settled: <R>(
          start: (target: PoolWorker, options: O) => Promise<R>,
        ) => Promise<R>;
        own: AbortSignal | undefined;
        abortedAtCall: boolean;
        savepointed: boolean;
        mark: { posted: boolean };
      } => {
        const own = withDeadline(given, method);
        // At the call, before anything can settle: D4 reversed decides on
        // this snapshot, not on whatever `own.signal.aborted` reads once the
        // statement has already rejected.
        const abortedAtCall = own.signal?.aborted === true;
        const merged = mergeSignals(signal, own.signal);
        const release = () => {
          merged.release();
          own.release();
        };
        const savepointed = opensSavepoint(sql, own.signal, abortedAtCall);
        const mark = { posted: false };
        const options = { ...given, signal: merged.signal } as O;
        // A savepointed write's QUERY runs with the transaction's signal alone,
        // so that only a death cuts it: SQLite closes every savepoint when it
        // interrupts a write (spec 2026-09-11, §1).
        const driving = savepointed ? ({ ...given, signal } as O) : options;
        const settled = async <R>(
          start: (target: PoolWorker, options: O) => Promise<R>,
        ): Promise<R> => {
          let failed = false;
          let error: unknown;
          // Set when the caller was rejected by its own signal while the write
          // ran on: from then on the wait belongs to `abandoned`.
          let left = false;
          try {
            if (abandoned) await entryWait(options.signal);
            if (!savepointed) return await start(via(false, mark), options);
            // Its own signal may have fired during the wait: then it never
            // reached the worker, and rejects alone.
            own.signal?.throwIfAborted();
            const running = start(via(true, mark), driving);
            const { aborted, teardown } = makeAbortRace(own.signal);
            try {
              return await (aborted
                ? Promise.race([running, aborted])
                : running);
            } catch (e) {
              if (
                mark.posted &&
                own.signal?.aborted === true &&
                e === own.signal.reason
              ) {
                left = true;
                abandon(running, method);
              }
              throw e;
            } finally {
              teardown();
            }
          } catch (e) {
            failed = true;
            error = e;
            throw e;
          } finally {
            release();
            if (mark.posted && !left) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
        };
        return {
          options,
          driving,
          release,
          settled,
          own: own.signal,
          abortedAtCall,
          savepointed,
          mark,
        };
      };
```

Rewrite the doc comment above `withSignal`: keep its paragraphs on the merged signal, on "a statement does not resolve until the worker is idle again", on the cost of `quiesce()` and on the per-statement `timeout`, and add:

> `settled` takes the query helper as a function of the worker facade and the options, so it chooses both. **One exception to the idle wait, by design (spec 2026-09-11, R1/R2):** a savepointed write rejected by its own signal resolves its caller at once and runs on; the wait moves to `abandoned`, which the next entry point awaits. The wait is owed only by a statement that was posted (`mark.posted`) — a statement the reuse guard refused never was.

4.6 — `releasing` (generator statements) keeps its rule until Task 4, but uses the facade's mark and the entry wait. Change its parameters to `(source, entry, st, sql, method)` with

```ts
        st: {
          release: () => void;
          own: AbortSignal | undefined;
          abortedAtCall: boolean;
          mark: { posted: boolean };
          options: { signal?: AbortSignal | undefined };
        },
```

and its generator body to:

```ts
          if (ending) {
            open.delete(entry);
            st.release();
            throw closedError(ending);
          }
          let failed = false;
          let error: unknown;
          try {
            if (abandoned) await entryWait(st.options.signal);
            yield* source;
          } catch (e) {
            failed = true;
            error = e;
            if (isAbandonedWrite(e, st.own, sql, st.abortedAtCall)) die(e);
            throw e;
          } finally {
            open.delete(entry);
            st.release();
            // (keep the existing comment about the generator half of settled's
            // invariant here)
            if (st.mark.posted) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
```

4.7 — Statement methods. In `db` and in the `bulkFor` target, every promise statement returns through the new `settled`:

```ts
        read: <T extends Record<string, unknown>>(
          sql: string,
          params?: unknown[],
          given?: SQLiteChunkOptions,
        ) => {
          if (ending) return Promise.reject(closedError(ending));
          const query = checksql(sql);
          const { settled } = withSignal(given, 'read', query);
          return settled((target, options) =>
            readWorker<T>(target, query, params, options),
          );
        },
```

and likewise `write` (`writeWorker<T>`), `first` (`firstWorker<T>`), and the target's `read`/`write` (`readWorker`, `writeWorker`, no type argument). `chunk` and `stream` become:

```ts
          const query = checksql(sql);
          const st = withSignal(given, 'chunk', query);
          const entry: OpenStatement = {};
          const source = chunkWorker<T>(via(false, st.mark), query, params, {
            ...st.options,
            onAbandon: st.release,
            onTransport: (iterator) => {
              entry.transport = iterator;
            },
          });
          return releasing(source, entry, st, query, 'chunk');
```

(`stream`: `streamRows<T>(via(false, st.mark), …)`, `'stream'`.)

4.8 — `commit()` and `rollback()` wait:

```ts
        commit: async () => {
          // (keep the existing comment)
          if (ending) {
            if (ending.kind === 'committed') return;
            throw closedError(ending);
          }
          if (abandoned) await entryWait(signal);
          await commitNow();
        },

        rollback: async () => {
          if (ending) {
            // (unchanged)
            return;
          }
          if (abandoned) await entryWait(signal);
          await rollbackNow();
        },
```

4.9 — `BEGIN` through the facade: `await exec(via(false), 'BEGIN');`.

4.10 — The automatic end waits too. Replace the `if (!done) { … }` block after `await closeOpenStatements();` in the `try` with:

```ts
        if (!done) {
          // (keep the existing comment on an abort landing after the callback)
          signal?.throwIfAborted();
          // Spec 2026-09-11, R2: the COMMIT waits for a write abandoned by its
          // own signal, and carries its undo.
          if (abandoned) await entryWait(signal);
          if (autoCommit) await commitNow();
          else await rollbackNow();
        }
```

4.11 — `isAbandonedWrite` stays (used by `releasing` until Task 4). Its doc comment gains: "Generator statements only, until spec 2026-09-11 §4 reaches `releasing`."

- [ ] **Step 5: Run the unit tests — expected PASS**

Run: `pnpm exec rstest run --project unit`
Expected: `status: pass`, `failedFiles: 0`; the new describe's 10 tests pass; the whole unit project passes — 442 tests (432 before, 10 new; the inverted test replaces one).

- [ ] **Step 6: Invert the browser tests in `tests/browser/tx-abort.test.ts`**

Delete the comment line `// Falsifiable for 1, 3, 4, 5: remove the isAbandonedWrite() → die() line from \`settled\` in transaction.ts.` Replace four tests:

*abandons the transaction when the callback catches it (async)* →

```ts
  // Spec 2026-09-11, R1. Falsifiable: in src/transaction.ts's `abandon`, drop
  // `pending = 'undo'` — the million rows are then committed.
  it('undoes a caught abandoned write, and the transaction goes on (async)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');
      let caught: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        caught = await tx
          .write(BIG_INSERT, [], { signal: abortAfter(30, reason) })
          .catch((e) => e);
        await tx.write('INSERT INTO t VALUES (2)');
      });

      expect(caught).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 2 },
      ]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 30_000);
```

*keeps none of a write that ran to its end on the sync build (R5)* →

```ts
  // Spec 2026-09-11, R3: nothing can cut the step on this build, and the
  // outcome is now the same as where something can. Falsifiable: as above.
  it('undoes a caught abandoned write on the sync build too, and goes on (R3)', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('abandon the write');
      await db.transaction(async (tx) => {
        await tx
          .write(BIG_INSERT, [], { signal: abortAfter(30, reason) })
          .catch(() => {});
        await tx.write('INSERT INTO t VALUES (2)');
      });

      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 2 },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);
```

*abandons the transaction for a write abandoned by its own timeout* →

```ts
  // Falsifiable: as for the signal above.
  it('undoes a write abandoned by its own timeout, and goes on', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const before = workerIdentity(db);
      let caught: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        caught = await tx
          .write(BIG_INSERT, [], { timeout: 30 })
          .catch((e) => e);
        await tx.write('INSERT INTO t VALUES (2)');
      });

      expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 30 });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 2 },
      ]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 30_000);
```

*abandons the transaction for a write issued through tx.first()* (replace its two falsifier comments too) →

```ts
  // The SQL decides, not the method (spec 2026-09-10, D5): a write through
  // first() is savepointed like any other. Falsifiable: make opensSavepoint()
  // return false — the write is then cut mid-step and SQLite takes the
  // transaction with it.
  it('undoes a caught write issued through tx.first(), and goes on', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const reason = new Error('cut mid-step');
      let caught: unknown;
      await db.transaction(async (tx) => {
        caught = await tx
          .first(`${BIG_INSERT} RETURNING x`, [], {
            signal: abortAfter(30, reason),
          })
          .catch((e) => e);
        await tx.write('INSERT INTO t VALUES (1)');
      });

      expect(caught).toBe(reason);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);
```

The remaining tests of the file are unchanged and must still pass — in particular *costs no worker and no committed data when the callback does not catch it* (the uncaught case) and the two `bulkWrite`/`output` tests (Task 5 inverts them).

- [ ] **Step 7: Add T2-T6 to `tests/browser/tx-savepoint.test.ts`**

```ts
/** A 3 000 000-row insert: long enough on Chromium for a timing bound to discriminate. */
const HUGE_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT x FROM c';

describe('a write the callback abandons by its own signal (spec 2026-09-11, R1-R3)', () => {
  for (const vfs of ['OPFSAdaptiveVFS', 'MemoryVFS'] as const) {
    // Falsifiable: in `settled`, `await worker.quiesce()` before rethrowing the
    // own abort — the rejection then arrives when the write ends, and the next
    // statement waits for nothing.
    it(`rejects at the deadline, and the next statement pays for the rest (T2, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let rejectedAfter = 0;
        let nextWaited = 0;
        await db.transaction(async (tx) => {
          const t0 = performance.now();
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          const t1 = performance.now();
          await tx.write('INSERT INTO t VALUES (1)');
          rejectedAfter = t1 - t0;
          nextWaited = performance.now() - t1;
        });
        expect(nextWaited).toBeGreaterThan(rejectedAfter);
        expect(await bigCount(db)).toBe(0);
        expect(await rowsOf(db)).toEqual([0, 1]);
      } finally {
        await db.close();
      }
    }, 60_000);

    // Falsifiable: in `entryWait`, await `abandoned` without the race — the
    // waiting write then lands, and its row 9 is committed.
    it(`rejects a statement that times out behind an abandoned write, alone (T5, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let second: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          second = await tx
            .write('INSERT INTO t VALUES (9)', [], { timeout: 20 })
            .catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(second).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 20 });
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);

    // Falsifiable: make commitNow() send its COMMIT with `exec(worker, …)`
    // instead of `via(false)` — the COMMIT then carries no undo and the
    // million rows are committed.
    it(`commits only what preceded a caught abandoned write when the callback returns at once (T6, ${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        });
        expect(await rowsOf(db)).toEqual([0, 1]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);
  }

  // On a build that can cut a step: the rejection escapes, the transaction
  // dies, and the background write is cut rather than awaited. Falsifiable:
  // start the savepointed write with `{ ...given, signal: undefined }` in
  // `settled` — the death then cannot cut it and transaction() waits for the
  // whole write.
  it('cuts the write, keeps nothing, and aborts tx.signal when the rejection escapes (T3)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const natural = await timed(() => db.write(HUGE_INSERT));
      await db.write('DELETE FROM big');
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');
      let seen!: AbortSignal;
      const took = await timed(() =>
        expect(
          db.transaction(async (tx) => {
            seen = tx.signal;
            await tx.write('INSERT INTO t VALUES (1)');
            await tx.write(HUGE_INSERT, [], {
              signal: abortAfter(30, reason),
            });
          }),
        ).rejects.toBe(reason),
      );
      expect(took).toBeLessThan(natural / 2);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 120_000);

  // Falsifiable: as T3.
  it("cuts an abandoned write when the transaction's own timeout expires (T4)", async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const natural = await timed(() => db.write(HUGE_INSERT));
      await db.write('DELETE FROM big');
      let outcome: unknown;
      const took = await timed(async () => {
        outcome = await db
          .transaction(
            async (tx) => {
              await tx.write('INSERT INTO t VALUES (1)');
              await tx.write(HUGE_INSERT, [], { timeout: 30 }).catch(() => {});
              await tx.write('INSERT INTO t VALUES (2)');
            },
            { timeout: 150 },
          )
          .catch((e) => e);
      });
      expect(outcome).toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 150 });
      expect(took).toBeLessThan(natural / 2);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});
```

- [ ] **Step 8: The `sync` isolated build — create `tests/browser/isolated/tx-savepoint.test.ts`**

```ts
import { describe, expect, it } from '@rstest/core';
import { createTestClient } from '../helpers';

/**
 * spec 2026-09-11 on the one configuration the ordinary projects cannot reach:
 * the `sync` build under cross-origin isolation, where the abort slot CAN cut
 * a running step — so a savepointed write must not be cut by its own signal,
 * and must be cut by the transaction's death.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

const setUp = async () => {
  const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  await db.write('INSERT INTO t VALUES (0)');
  return db;
};

describe('a savepointed write on the sync isolated build (spec 2026-09-11)', () => {
  // Falsifiable: drive the savepointed write with the merged signal in
  // `settled` (`start(via(true, mark), options)`) — the slot then cuts it,
  // SQLite rolls the transaction back, and it dies.
  it('undoes a caught abandoned write, and the transaction goes on', async () => {
    expect(globalThis.crossOriginIsolated).toBe(true);
    const db = await setUp();
    try {
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        await tx.write('INSERT INTO t VALUES (2)');
      });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 2 },
      ]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it('keeps nothing when the rejection escapes', async () => {
    const db = await setUp();
    try {
      const reason = new Error('abandon the write');
      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          const ctl = new AbortController();
          setTimeout(() => ctl.abort(reason), 30);
          await tx.write(BIG_INSERT, [], { signal: ctl.signal });
        }),
      ).rejects.toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 9: Run every touched browser file — expected PASS**

Run: `pnpm exec rstest run --project chromium tx-abort tx-savepoint tx-timeout tx-handle tx-quiesce transaction abandon-transaction close` and the same with `--config rstest.firefox.config.ts`, then `pnpm exec rstest run --config rstest.isolated.config.ts tx-savepoint`.
Expected: `status: pass`, `failedFiles: 0` on each. If a test outside this task's list moves, stop and report it — the spec says nothing else should.

- [ ] **Step 10: Verify the falsifiers** of every new or rewritten test (unit and browser), as in Task 1, Step 3.

- [ ] **Step 11: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/transaction.ts tests/unit/transaction.test.ts tests/browser/tx-abort.test.ts tests/browser/tx-savepoint.test.ts tests/browser/isolated/tx-savepoint.test.ts
git commit -m "fix(transaction): a caught write abort is undone, and the transaction goes on

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: Generator statements — `chunk()`/`stream()` issuing a write follow the same split

**Files:**
- Modify: `src/transaction.ts` (`releasing`, `chunk`, `stream`; delete `isAbandonedWrite`)
- Modify: `tests/unit/transaction.test.ts`
- Modify: `tests/browser/tx-savepoint.test.ts`

**Interfaces:**
- Consumes: `withSignal`'s `savepointed`, `driving`, `mark`; `abandon`, `entryWait`, `via` (Task 3).
- Produces: `drainToEnd(source)`.

- [ ] **Step 1: Write the failing tests**

Unit — replace *dies when a write issued through tx.chunk() is abandoned by its own signal* with:

```ts
  // Spec 2026-09-11, R1, the generator half. Falsifiable: in `releasing`, drop
  // the abandon(…) call — the next message then releases the write instead of
  // rolling it back.
  it('rolls back a write issued through tx.chunk() abandoned by its own signal, and goes on', async () => {
    const reached = deferred();
    const gate = deferred();
    const worker = fakeWorker([], {
      'INSERT INTO t VALUES (1) RETURNING a': async () => {
        reached.resolve();
        await gate.promise;
      },
    });
    const { transaction } = harness(worker);
    const own = new AbortController();
    const reason = new Error('this chunk only');
    let caught: unknown;
    await transaction(async (tx) => {
      const gen = tx.chunk('INSERT INTO t VALUES (1) RETURNING a', [], {
        signal: own.signal,
      });
      const next = gen.next();
      await reached.promise;
      own.abort(reason);
      caught = await next.catch((e) => e);
      gate.resolve();
      await tx.write('INSERT INTO t VALUES (2)');
    });
    expect(caught).toBe(reason);
    expect(worker.executed).toEqual([
      'BEGIN',
      'SAVEPOINT __bsq_sp',
      'INSERT INTO t VALUES (1) RETURNING a',
      'ROLLBACK TO __bsq_sp',
      'RELEASE __bsq_sp',
      'INSERT INTO t VALUES (2)',
      'COMMIT',
    ]);
  });
```

Browser — append to `tests/browser/tx-savepoint.test.ts`:

```ts
describe('a write issued through a generator (spec 2026-09-11, §4)', () => {
  for (const vfs of ['OPFSAdaptiveVFS', 'MemoryVFS'] as const) {
    // Falsifiable: in `releasing`, drop the abandon(…) call — the write is
    // then closed like any generator: cut where a step can be cut (the
    // transaction dies), committed where it cannot.
    it(`undoes a caught write issued through tx.chunk(), and goes on (${vfs})`, async () => {
      const db = await setUp({ vfs });
      try {
        let caught: unknown;
        await db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          caught = await (async () => {
            for await (const _rows of tx.chunk(`${BIG_INSERT} RETURNING x`, [], {
              timeout: 30,
            })) {
              // The first chunk comes only after the whole DML.
            }
          })().catch((e) => e);
          await tx.write('INSERT INTO t VALUES (2)');
        });
        expect(caught).toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    }, 60_000);
  }
});
```

- [ ] **Step 2: Run — expected FAIL**

Run: `pnpm exec rstest run --project unit transaction` and `pnpm exec rstest run --project chromium tx-savepoint`
Expected: FAIL (the unit list has no savepoint statements; the browser transaction dies or commits the rows).

- [ ] **Step 3: Implement**

3.1 — Add, beside `abandon`:

```ts
      /**
       * Consumes an abandoned generator write to its end, discarding its rows,
       * so the worker's credits keep flowing and the write can finish (spec
       * 2026-09-11, §4). A `next()` still pending from the lost race is queued
       * ahead of this one, as async generators do.
       */
      const drainToEnd = async (source: AsyncGenerator<unknown>) => {
        for (;;) {
          const next = await source.next();
          if (next.done) return;
        }
      };
```

3.2 — `releasing`'s `st` gains `savepointed: boolean`. Replace its generator body with:

```ts
          if (ending) {
            open.delete(entry);
            st.release();
            throw closedError(ending);
          }
          let failed = false;
          let error: unknown;
          // As in `settled`: set when the consumer was rejected by the
          // statement's own signal while the write ran on.
          let left = false;
          try {
            if (abandoned) await entryWait(st.options.signal);
            if (!st.savepointed) {
              yield* source;
              return;
            }
            st.own?.throwIfAborted();
            const { aborted, teardown } = makeAbortRace(st.own);
            try {
              while (true) {
                const next = aborted
                  ? await Promise.race([source.next(), aborted])
                  : await source.next();
                if (next.done) return;
                yield next.value;
              }
            } catch (e) {
              if (
                st.mark.posted &&
                st.own?.aborted === true &&
                e === st.own.reason
              ) {
                left = true;
                abandon(drainToEnd(source), method);
              }
              throw e;
            } finally {
              teardown();
              // What `yield*` did for the other branch: the consumer's break or
              // return() reaches the query. Not for an abandoned write, which
              // drainToEnd now owns.
              if (!left) await source.return(undefined);
            }
          } catch (e) {
            failed = true;
            error = e;
            throw e;
          } finally {
            open.delete(entry);
            st.release();
            // (keep the existing comment on the generator half of the invariant)
            if (st.mark.posted && !left) {
              await worker.quiesce();
              dieIfConnectionLeft(failed, error, method);
            }
          }
```

3.3 — `chunk`/`stream` hand the facade and the options their savepoint needs:

```ts
          const source = chunkWorker<T>(
            via(st.savepointed, st.mark),
            query,
            params,
            {
              ...(st.savepointed ? st.driving : st.options),
              onAbandon: st.release,
              onTransport: (iterator) => {
                entry.transport = iterator;
              },
            },
          );
```

(`stream` the same with `streamRows<T>`.)

3.4 — Delete `isAbandonedWrite` and its doc comment: nothing uses it any more. `abortedAtCall` stays, used by `opensSavepoint`.

- [ ] **Step 4: Run — expected PASS**

Run: `pnpm exec rstest run --project unit` then `pnpm exec rstest run --project chromium tx-savepoint tx-abort tx-quiesce transaction abandon-transaction tx-timeout` and the same on `--config rstest.firefox.config.ts`.
Expected: `status: pass`, `failedFiles: 0` everywhere.

- [ ] **Step 5: Verify the two falsifiers.**

- [ ] **Step 6: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/transaction.ts tests/unit/transaction.test.ts tests/browser/tx-savepoint.test.ts
git commit -m "fix(transaction): a write through chunk() or stream() is undone the same way

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `bulkWrite()`/`output()` — an abandoned load keeps its completed batches (R4, D6)

Every batch is already a savepointed `tx.write` since Task 3 (it carries the load's signal). What still kills the transaction is the `onAbandoned` hook; this task deletes it.

**Files:**
- Modify: `src/bulk.ts`
- Modify: `src/transaction.ts` (`deps.bulkFor` type; the `bulkFor` call)
- Modify: `tests/browser/tx-abort.test.ts`
- Modify: `tests/browser/tx-savepoint.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/browser/tx-abort.test.ts`, replace *abandons the transaction when a tx.bulkWrite is abandoned between batches* (and its comment) with:

```ts
  // Spec 2026-09-11, R4. Falsifiable: restore the `onAbandoned` hook in
  // src/bulk.ts — the abandoned load kills the transaction again.
  it('keeps the transaction when a tx.bulkWrite is abandoned between batches', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('stop loading');
      const ctl = new AbortController();
      let closed: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        const writer = tx.bulkWrite('t', ['a'], { signal: ctl.signal });
        await writer.enqueue({ a: 2 });
        ctl.abort(reason);
        closed = await writer.close().catch((e) => e);
        await tx.write('INSERT INTO t VALUES (3)');
      });

      expect(closed).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 3 },
      ]);
    } finally {
      await db.close();
    }
  });
```

and *abandons the transaction, and leaves no staging table, when a tx.output is abandoned* with:

```ts
  // Falsifiable: as above.
  it('keeps the transaction, and leaves no staging table, when a tx.output is abandoned', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('stop loading');
      const ctl = new AbortController();
      let closed: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        const out = tx.output('target', { a: 'INTEGER' }, { signal: ctl.signal });
        await out.enqueue({ a: 2 });
        ctl.abort(reason);
        closed = await out.close().catch((e) => e);
        await tx.write('INSERT INTO t VALUES (3)');
      });

      expect(closed).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 3 },
      ]);
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

Append T9 to `tests/browser/tx-savepoint.test.ts`:

```ts
describe('a load the callback abandons (spec 2026-09-11, R4, D6)', () => {
  // One savepoint per batch: a load abandoned after its first batch keeps
  // that batch. Deterministic: with `queueSize` one batch, the enqueue that
  // completes batch 1 parks until batch 1 has settled. Falsifiable: restore
  // the `onAbandoned` hook in src/bulk.ts — the transaction then dies and
  // nothing is kept.
  it('keeps the batches an abandoned tx.bulkWrite completed (T9)', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      // src/bulk.ts: maxVariables (32766) / one key.
      const batch = 32766;
      const reason = new Error('stop loading');
      const ctl = new AbortController();
      let closed: unknown;
      await db.transaction(async (tx) => {
        const writer = tx.bulkWrite('t', ['a'], {
          signal: ctl.signal,
          queueSize: batch,
        });
        for (let i = 0; i < batch; i++) await writer.enqueue({ a: 1 });
        await writer.enqueue({ a: 2 });
        ctl.abort(reason);
        closed = await writer.close().catch((e) => e);
        await tx.write('INSERT INTO t VALUES (3)');
      });
      expect(closed).toBe(reason);
      const counts = await db.read<{ a: number; n: number }>(
        'SELECT a, count(*) AS n FROM t GROUP BY a ORDER BY a',
      );
      expect(counts).toEqual([
        { a: 0, n: 1 },
        { a: 1, n: batch },
        { a: 3, n: 1 },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run — expected FAIL**

Run: `pnpm exec rstest run --project chromium tx-abort tx-savepoint`
Expected: the three tests FAIL — the transaction dies on the abandoned load.

- [ ] **Step 3: Implement**

`src/bulk.ts`: in the target's type, delete `onAbandoned` and its doc comment; in `const { read, write, transaction, onAbandoned } = target;` drop `onAbandoned`; delete the block from `// A transaction's bulkWrite is one of its writes:` through `signal.addEventListener('abort', abandon, { once: true }); }`, and put in its place:

```ts
      // Inside a transaction each batch is a `tx.write` carrying this signal,
      // so the transaction runs it inside its own savepoint (spec 2026-09-11,
      // D6): an abandoned load keeps the batches it completed — as it does
      // outside a transaction, where each is already committed — and the
      // batch in flight is undone. Nothing here needs to know which it is.
```

and delete `signal?.removeEventListener('abort', abandon);` from `close()`'s `finally`.

`src/transaction.ts`: delete `onAbandoned` and its doc comment from `deps.bulkFor`'s target type, and `onAbandoned: (cause: unknown) => die(cause),` from the `deps.bulkFor({ … })` call.

- [ ] **Step 4: Run — expected PASS**

Run: `pnpm exec rstest run --project unit`, then `pnpm exec rstest run --project chromium tx-abort tx-savepoint bulk-write output backpressure` and the same on `--config rstest.firefox.config.ts`.
Expected: `status: pass`, `failedFiles: 0`.

- [ ] **Step 5: Verify the falsifiers.**

- [ ] **Step 6: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/bulk.ts src/transaction.ts tests/browser/tx-abort.test.ts tests/browser/tx-savepoint.test.ts
git commit -m "fix(bulk): an abandoned load inside a transaction keeps its completed batches

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Transaction-control statements are never wrapped (D8), and a consumer's savepoints (T8)

**Files:**
- Modify: `src/utils.ts`
- Modify: `src/transaction.ts` (`opensSavepoint`)
- Modify: `tests/unit/utils.test.ts`, `tests/unit/transaction.test.ts`, `tests/browser/tx-savepoint.test.ts`

**Interfaces:**
- Produces: `export const isTransactionControl: (sql: string) => boolean` in `src/utils.ts`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/utils.test.ts` — add (import `isTransactionControl` alongside the file's other imports from `../../src/utils`):

```ts
describe('isTransactionControl', () => {
  it('recognises the statements that manage a transaction or its savepoints', () => {
    for (const sql of [
      'SAVEPOINT u',
      'release u',
      '  ROLLBACK TO u',
      'ROLLBACK',
      'BEGIN IMMEDIATE',
      'COMMIT',
      'END',
    ])
      expect(isTransactionControl(sql)).toBe(true);
  });

  it('refuses everything else', () => {
    for (const sql of [
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a = 1',
      'WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c',
      'SELECT 1',
      'RELEASED',
    ])
      expect(isTransactionControl(sql)).toBe(false);
  });
});
```

`tests/unit/transaction.test.ts` — append to the savepoint describe:

```ts
  // D8. Falsifiable: drop `!isTransactionControl(sql)` from opensSavepoint().
  it('never wraps a transaction-control statement, even with its own timeout', async () => {
    const worker = fakeWorker([]);
    const { transaction } = harness(worker);
    await transaction(async (tx) => {
      await tx.write('SAVEPOINT u');
      await tx.write('RELEASE u', [], { timeout: 60_000 });
    });
    expect(worker.executed).toEqual(['BEGIN', 'SAVEPOINT u', 'RELEASE u', 'COMMIT']);
  });
```

`tests/browser/tx-savepoint.test.ts` — append:

```ts
describe("a consumer's own savepoints (spec 2026-09-11, D7, D8)", () => {
  // Falsifiable: drop `!isTransactionControl(sql)` from opensSavepoint() — the
  // timed RELEASE u then runs inside __bsq_sp and pops it, and the COMMIT's
  // RELEASE __bsq_sp fails.
  it('undoes to the consumer savepoint across a caught abandoned write (T8)', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      await db.transaction(async (tx) => {
        await tx.write('SAVEPOINT u');
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        await tx.write('INSERT INTO t VALUES (2)');
        await tx.write('ROLLBACK TO u');
        await tx.write('INSERT INTO t VALUES (3)');
        await tx.write('RELEASE u', [], { timeout: 5_000 });
      });
      expect(await rowsOf(db)).toEqual([0, 3]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run — expected FAIL**

Run: `pnpm exec rstest run --project unit utils transaction` and `pnpm exec rstest run --project chromium tx-savepoint`
Expected: FAIL — `isTransactionControl` undefined; the unit list has a `SAVEPOINT __bsq_sp`; the browser transaction rejects on the COMMIT.

- [ ] **Step 3: Implement**

`src/utils.ts`, beside `isWriteQuery`:

```ts
/**
 * Whether `sql` manages the transaction or its savepoints rather than data
 * (spec 2026-09-11, D8). Never wrapped in the library's savepoint: there is
 * nothing to undo, and a `RELEASE u` run inside it would pop it along with
 * `u`. The leading keyword decides: these statements are never compound.
 */
export const isTransactionControl = (sql: string) =>
  /^\s*(SAVEPOINT|RELEASE|ROLLBACK|BEGIN|COMMIT|END)\b/i.test(sql);
```

`src/transaction.ts`: import it with `isWriteQuery`; `opensSavepoint` becomes

```ts
      ) =>
        own !== undefined &&
        !abortedAtCall &&
        isWriteQuery(sql) &&
        !isTransactionControl(sql);
```

and its doc comment gains: "Never a transaction-control statement (D8)."

- [ ] **Step 4: Run — expected PASS**, unit project and `tx-savepoint` on both engines.

- [ ] **Step 5: Verify the falsifiers.**

- [ ] **Step 6: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add src/utils.ts src/transaction.ts tests/unit/utils.test.ts tests/unit/transaction.test.ts tests/browser/tx-savepoint.test.ts
git commit -m "fix(transaction): never wrap a savepoint or transaction statement in the library's own

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Documentation

Consumer pages are edited iteratively with the user (`mem:conventions`): make these edits, show the diff, and wait for the user before committing `API.md` and `CHANGELOG.md`.

**Files:**
- Modify: `API.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-09-10-transaction-abort-design.md`

- [ ] **Step 1: `API.md`, *Inside a transaction***

In the paragraph beginning **Rows land only on a `COMMIT` that succeeds.**, replace the sentence "Catching your own statement's rejection does not let you commit around an abort." with "Catching a rejection caused by the transaction's own `signal` or `timeout` does not let you commit around it."

Replace the whole paragraph beginning **A write abandoned while it runs abandons its transaction; an abandoned read does not.** with:

```markdown
**A statement you catch has no effect, and the transaction goes on.** A statement's own `signal` or `timeout` rejects that statement at once, with its own reason, and whatever it was — a read, a write, a `bulkWrite()` batch — it leaves nothing behind. Caught, your callback continues: what it wrote before still stands, and a later commit keeps it; an abandoned `bulkWrite()` keeps the batches it had completed. A write that was already running when the abort landed runs on to its end and is then undone, so the next statement you issue — or the commit — waits for it, with the write lock held; that statement's own `signal` or `timeout` bounds the wait. Let the rejection escape the callback instead and the whole transaction is abandoned: `transaction()` rejects with that reason and nothing the transaction wrote is kept.
```

- [ ] **Step 2: `API.md`, *client*.bulkWrite**

In the paragraph beginning **Batches are committed as they flush, so a load is never all-or-nothing.**, replace "— run `bulkWrite()` on a `tx` if you need all or nothing." with "— for all or nothing, use a [transaction](#clienttransaction)."

- [ ] **Step 3: `CHANGELOG.md`, `## Unreleased`**

*Changed*, the `bulkWrite` lock entry: replace "Use `tx.bulkWrite` where you need all or nothing." with "Use a transaction where you need all or nothing."

*Fixed*, the entry **An abandoned write could leave the rest of a transaction outside it.**: replace its last sentence "A write abandoned while it runs now abandons its transaction on every build, and a rejected write never has an effect." with "A write abandoned while it runs now has no effect, on every build: caught, the transaction goes on without it; uncaught, the transaction is abandoned."

- [ ] **Step 4: The 2026-09-10 spec**

Below its existing amendment block at the top, add:

```markdown
**Amended 2026-09-11 — superseded in part by
`docs/superpowers/specs/2026-09-11-tx-savepoint-design.md`.** R1's first two bullets (a write,
or a load, abandoned while it runs kills the transaction), R5 (the `sync` build without
isolation killed it too, for uniformity) and D1 (option 1, not the savepoint) no longer hold: a
caught abandoned write is undone by a savepoint and the transaction goes on. The rest of this
design stands.
```

- [ ] **Step 5: Show the user the diff of the three files; wait for their go before committing**

```bash
git diff -- API.md CHANGELOG.md docs/superpowers/specs/2026-09-10-transaction-abort-design.md
```

- [ ] **Step 6: Commit, once the user has approved the wording**

```bash
git add API.md CHANGELOG.md docs/superpowers/specs/2026-09-10-transaction-abort-design.md
git commit -m "docs: a caught statement abort leaves the transaction whole

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: M3, the full verification, and the architecture memory

**Files:**
- Modify: `.serena/memories/measurements.md` (through Serena's `edit_memory`), `.serena/memories/architecture.md` (same)
- Scratch: `.scratchpad/savepoint-probe/` (not versioned)

- [ ] **Step 1: M3 — the real B's cost**

Copy `.scratchpad/savepoint-probe/probe-b.test.ts` to `.scratchpad/savepoint-probe/probe-m3.test.ts`, keep the arms `base` and add

```ts
  real: async (tx) => {
    for (let k = 0; k < K; k++) await tx.write(INS, [], { timeout: 60_000 });
  },
```

(the timeout makes every write a savepointed one; nothing fires). Copy it to `tests/browser/zz-m3.test.ts`, run three times on each engine (`pnpm exec rstest run --project chromium zz-m3`, `pnpm exec rstest run --config rstest.firefox.config.ts zz-m3`), logs to `.scratchpad/savepoint-probe/m3-*.log`, delete the copy. Report (real − base)/200 per VFS and engine, median of three, beside the proxy's figures; add them to TX-SAVEPOINT in `mem:measurements` with the date and method.

- [ ] **Step 2: Full verification — every figure read, none carried**

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm build
pnpm test
pnpm test:conformance
pnpm test:consumer
```

Expected: `tsc` clean; lint 0 errors; build clean; `pnpm test` THREE reports, each `status: pass`, `failedFiles: 0`, and exactly **1 skipped** on each browser config (`abandon-gc`); conformance TWO reports, 73 passed / 12 skipped each; consumer 24/24. Report the counts as read.

- [ ] **Step 3: `mem:architecture`**

Through `edit_memory`, in *Load-bearing invariants*:

- In **A transaction statement does not resolve until the worker is idle again**: `settled` now takes the helper as a function of the worker facade and the options; the idle wait is owed only by a statement that was POSTED (`mark.posted`, which replaced `owesWait`); the one exception is a savepointed write rejected by its own signal, whose wait moves to `abandoned`, awaited by every entry point.
- In **A transaction ends once, and its handle knows it**, replace the bullet **What kills a transaction** so it no longer lists a write or load abandoned by its own signal: that write is now undone by the library's savepoint (spec 2026-09-11). What kills it: the three outside causes, an error escaping the callback, and the connection leaving the transaction.
- Add: **Every message a transaction sends goes through `via`, except the teardown ROLLBACK** — the facade whose `query` hands the pool a thunk read at post time; it carries the pending conclusion of `__bsq_sp`. A new statement method that calls a query helper with the raw worker breaks the undo; `tests/unit/transaction.test.ts` T7 is parameterised over the methods to catch it.

- [ ] **Step 4: Commit the memories**

```bash
git add .serena/memories/measurements.md .serena/memories/architecture.md
git commit -m "docs(memory): the transaction's savepoint, and what the real B costs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```
