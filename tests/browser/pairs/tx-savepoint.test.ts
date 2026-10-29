import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  interceptWorkers,
  scaled,
  theQueryIsRunning,
} from '../helpers';

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

type Debuggable = { debug: { workers: { creationTime: number }[] } };

/** The pool's workers by birth time: a change means one was evicted and respawned. */
const workerIdentity = (db: unknown) =>
  (db as Debuggable).debug.workers.map((w) => w.creationTime).join(',');

const setUp = async () => {
  const db = await createTestClient({ poolSize: 1, debug: true });
  await db.run('CREATE TABLE t (a INTEGER)');
  await db.run('CREATE TABLE big (x INTEGER)');
  await db.run('INSERT INTO t VALUES (0)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.all<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

/**
 * One INSERT whose single step() runs for hundreds of milliseconds (Chromium)
 * to seconds (Firefox), so an abort at 30 ms lands inside it.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

const abortAfter = (ms: number, reason: unknown) => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(reason), ms);
  return ctl.signal;
};

const bigCount = async (db: Db) =>
  (await db.all<{ n: number }>('SELECT count(*) AS n FROM big'))[0]?.n;

/** The debug records of these statements, in the client's request history. */
const queriesOf = (db: Db, sqls: string[]) => {
  const all = (db.debug?.requests ?? []).flatMap((r) => r.queries);
  return sqls.map((sql) => all.findLast((q) => q.sql === sql));
};

describe('an SQL error the callback catches (spec 2026-09-11 §1)', () => {
  // The first row of the spec's §1 table, which no test covered. Falsifiable:
  // in src/transaction.ts's `settled`, call die(e) in the catch for every
  // rejection — the caught violation then kills the transaction and
  // INSERT (2) never lands.
  it('lets the transaction go on and commit what preceded it (T11)', async () => {
    const db = await setUp();
    try {
      await db.run('CREATE UNIQUE INDEX t_a ON t (a)');
      let caught: unknown;
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
        caught = await tx.run('INSERT INTO t VALUES (1)').catch((e) => e);
        await tx.run('INSERT INTO t VALUES (2)');
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
    const db = await setUp();
    try {
      await db.run('CREATE UNIQUE INDEX t_a ON t (a)');
      const before = workerIdentity(db);
      let caught: unknown;
      let later: unknown;
      const finished = deferred();
      const outcome = await db
        .transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          caught = await tx
            .run('INSERT OR ROLLBACK INTO t VALUES (1)')
            .catch((e) => e);
          later = await tx.all('SELECT a FROM t').catch((e) => e);
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

/** A 3 000 000-row insert: long enough on Chromium for a timing bound to discriminate. */
/**
 * One INSERT whose single step() computes for minutes before it writes its one
 * row: run to its end it outlives the test's timeout, which is the bound, and
 * a cut leaves nothing written.
 */
const ENDLESS_INSERT =
  'INSERT INTO big SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000000) SELECT x FROM c)';

describe('a write the callback abandons by its own signal (spec 2026-09-11, R1-R3)', () => {
  // Falsifiable: in `settled`, `await worker.quiesce()` before rethrowing the
  // own abort — the rejection then arrives when the write ends, when it is no
  // longer running. Holds on every build: the promise rejects at
  // the deadline whether or not the underlying step can be cut, so this no
  // longer loops over VFS (spec 2026-09-15, A5).
  it(
    'rejects at the deadline, and the next statement pays for the rest (T2)',
    async () => {
      const db = await setUp();
      try {
        let runningAtRejection = false;
        await db.transaction(async (tx) => {
          await tx.run(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          // Rejected at the deadline: the write is still running.
          runningAtRejection = theQueryIsRunning(db, BIG_INSERT)();
          await tx.run('INSERT INTO t VALUES (1)');
        });
        expect(runningAtRejection).toBe(true);
        // And the next statement paid for the rest: it started once the
        // abandoned write had ended.
        const [big, next] = queriesOf(db, [
          BIG_INSERT,
          'INSERT INTO t VALUES (1)',
        ]);
        expect(big?.endTime).toBeDefined();
        expect(next?.startTime).toBeGreaterThanOrEqual(
          big?.endTime ?? Infinity,
        );
        expect(await bigCount(db)).toBe(0);
        expect(await rowsOf(db)).toEqual([0, 1]);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  // Falsifiable: in `entryWait`, await `abandoned` without racing the
  // waiting statement's own signal — the rejection still arrives (`own`'s
  // pre-checked `throwIfAborted()` catches it once the wait ends), but only
  // once the abandoned write itself has finished, so the write is no longer
  // running when it rejects, and the assertion on that state goes red instead
  // of the outcome silently staying green.
  // Holds on every build (see T2's note).
  it(
    'rejects a statement that times out behind an abandoned write, alone (T5)',
    async () => {
      const db = await setUp();
      try {
        let second: unknown;
        let runningAtRejection = false;
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          await tx.run(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          second = await tx
            .run('INSERT INTO t VALUES (9)', [], { timeout: 20 })
            .catch((e) => e);
          // Rejected while the abandoned write still runs, alone.
          runningAtRejection = theQueryIsRunning(db, BIG_INSERT)();
          await tx.run('INSERT INTO t VALUES (2)');
        });
        expect(second).toMatchObject({
          code: 'OPERATION_TIMEOUT',
          timeout: 20,
        });
        expect(runningAtRejection).toBe(true);
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  // Falsifiable: make commitNow() send its COMMIT with `exec(worker, …)`
  // instead of `via(false)` — the COMMIT then carries no undo and the
  // million rows are committed. Holds on every build (see T2's note).
  it(
    'commits only what preceded a caught abandoned write when the callback returns at once (T6)',
    async () => {
      const db = await setUp();
      try {
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          await tx.run(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        });
        expect(await rowsOf(db)).toEqual([0, 1]);
        expect(await bigCount(db)).toBe(0);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  // On a build that can cut a step: the rejection escapes, the transaction
  // dies, and the background write is cut rather than awaited. Falsifiable:
  // start the savepointed write with `{ ...given, signal: undefined }` in
  // `settled` — the death then cannot cut it and transaction() waits for the
  // whole write.
  it('cuts the write, keeps nothing, and aborts tx.signal when the rejection escapes (T3)', {
    tags: ['requires:interruptible'],
    timeout: scaled(120_000),
  }, async () => {
    const db = await setUp();
    try {
      const before = workerIdentity(db);
      const reason = new Error('abandon the write');
      let seen!: AbortSignal;
      // A write that is not cut runs to its end, past the test's timeout:
      // transaction() settling at all is what shows the write was cut.
      await expect(
        db.transaction(async (tx) => {
          seen = tx.signal;
          await tx.run('INSERT INTO t VALUES (1)');
          await tx.run(ENDLESS_INSERT, [], {
            signal: abortAfter(30, reason),
          });
        }),
      ).rejects.toBe(reason);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  });

  // Falsifiable: a worker that never interrupts a step (its progress handler
  // always returning 0) — the write then runs to its end, past the test's
  // timeout (2026-10-29). Until the write outlived the timeout this had no
  // falsifier: its bound was a duration against the write's natural run, and
  // measured how fast the transaction rejects at its own 150 ms timeout.
  // `requires:interruptible` stays: the subject is a build that can cut a step.
  it("cuts an abandoned write when the transaction's own timeout expires (T4)", {
    tags: ['requires:interruptible'],
    timeout: scaled(120_000),
  }, async () => {
    const db = await setUp();
    try {
      // A write that is not cut runs to its end, past the test's timeout.
      const outcome = await db
        .transaction(
          async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            await tx.run(ENDLESS_INSERT, [], { timeout: 30 }).catch(() => {});
            await tx.run('INSERT INTO t VALUES (2)');
          },
          { timeout: 150 },
        )
        .catch((e) => e);
      expect(outcome).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 150,
      });
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  });
});

describe('the savepoint asks SQLite (spec 2026-10-26, § Transactions)', () => {
  // Falsifiable: in src/transaction.ts's `abandon`, drop `pending = 'undo'` —
  // the next message then releases the abandoned write instead of undoing it.
  it(
    'undoes a tx.run() write aborted by its own signal while it runs, and goes on',
    async () => {
      const db = await setUp();
      try {
        const before = workerIdentity(db);
        const reason = new Error('this write only');
        let caught: unknown;
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          caught = await tx
            .run(BIG_INSERT, [], { signal: abortAfter(30, reason) })
            .catch((e) => e);
          await tx.run('INSERT INTO t VALUES (2)');
        });
        expect(caught).toBe(reason);
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
        expect(workerIdentity(db)).toBe(before);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  /** The `savepoint` option of every query posted, keyed by its SQL. */
  const savepointsPosted = (worker: Worker) => {
    const seen: { sql: string; savepoint: unknown }[] = [];
    const post = worker.postMessage.bind(worker) as (
      message: unknown,
      ...rest: unknown[]
    ) => void;
    worker.postMessage = (message: unknown, ...rest: unknown[]) => {
      const data = message as {
        type?: string;
        sql?: string;
        options?: { savepoint?: unknown };
      };
      if (data?.type === 'query')
        seen.push({
          sql: String(data.sql),
          savepoint: data.options?.savepoint,
        });
      post(message, ...rest);
    };
    return seen;
  };

  // The regex called `SELECT 'INSERT'` a write; SQLite calls it a read, and a
  // read pays no savepoint (spec 2026-09-11, D4). The INSERT is the control:
  // the same signal on a write opens one. Falsifiable: have opensSavepoint
  // ignore the verdict — the SELECT then opens a savepoint too.
  it("opens no savepoint for SELECT 'INSERT' carrying its own signal", async () => {
    const records = interceptWorkers();
    const db = await setUp();
    try {
      const [record] = records;
      if (!record) throw new Error('the pool has a worker');
      const seen = savepointsPosted(record.worker);
      let result: unknown;
      await db.transaction(async (tx) => {
        result = await tx.run("SELECT 'INSERT'", [], {
          signal: new AbortController().signal,
        });
        await tx.run('INSERT INTO t VALUES (1)', [], {
          signal: new AbortController().signal,
        });
      });
      expect(result).toEqual({ rows: [{ "'INSERT'": 'INSERT' }], affected: 0 });
      const opened = (sql: string) =>
        seen
          .filter((q) => q.sql === sql)
          .map((q) => (q.savepoint as { open?: true } | undefined)?.open);
      expect(opened("SELECT 'INSERT'")).toEqual([undefined]);
      expect(opened('INSERT INTO t VALUES (1)')).toEqual([true]);
    } finally {
      await db.close();
    }
  });
});

describe('a load the callback abandons (spec 2026-09-11, R4, D6)', () => {
  // One savepoint per batch: a load abandoned after its first batch keeps
  // that batch. Deterministic: with `queueSize` one batch, the enqueue that
  // completes batch 1 parks until batch 1 has settled. Falsifiable: restore
  // the `onAbandoned` hook in src/bulk.ts — the transaction then dies and
  // nothing is kept.
  it(
    'keeps the batches an abandoned tx.bulkWrite completed (T9)',
    async () => {
      const db = await setUp();
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
          await tx.run('INSERT INTO t VALUES (3)');
        });
        expect(closed).toBe(reason);
        const counts = await db.all<{ a: number; n: number }>(
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
    },
    scaled(60_000),
  );
});

describe('a consumer savepoint and a RELEASE riding on a write (spec 2026-10-04)', () => {
  // The former F2: a RELEASE riding on a write could pop __bsq_sp with u. A
  // string holding the write and the RELEASE is now refused whole, before
  // either runs, so the stack and the write are untouched.
  // Falsifiable: send the string without the refusal (delete the `refuseMore`
  // call in src/worker/worker.ts) — the RELEASE runs and the test fails.
  it(
    'refuses a RELEASE riding on a write, running neither',
    async () => {
      const db = await setUp();
      try {
        const before = workerIdentity(db);
        let first: unknown;
        await db.transaction(async (tx) => {
          const sp = await tx.savepoint('u');
          await tx.run('INSERT INTO t VALUES (1)');
          first = await tx
            .run(`${BIG_INSERT}; RELEASE u`, [], { timeout: 30 })
            .catch((e) => e);
          await tx.run('INSERT INTO t VALUES (2)');
          await sp.release();
        });
        expect(first).toMatchObject({ code: 'MULTIPLE_STATEMENTS' });
        expect(await rowsOf(db)).toEqual([0, 1, 2]);
        expect(await bigCount(db)).toBe(0);
        expect(workerIdentity(db)).toBe(before);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );
});
