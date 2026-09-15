import { describe, expect, it } from '@rstest/core';
import { SQLITE_CODES } from '../../src/sqlite-codes';
import { createTestClient } from './helpers';
import type { Need } from './target';

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

const setUp = async (options: { needs?: readonly Need[] } = {}) => {
  const db = await createTestClient({ ...options, poolSize: 1, debug: true });
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write('CREATE TABLE big (x INTEGER)');
  await db.write('INSERT INTO t VALUES (0)');
  return db;
};

type Db = Awaited<ReturnType<typeof setUp>>;

const rowsOf = async (db: Db) =>
  (await db.read<{ a: number }>('SELECT a FROM t ORDER BY a')).map((r) => r.a);

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
    const db = await setUp();
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
    const db = await setUp();
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

/** A 3 000 000-row insert: long enough on Chromium for a timing bound to discriminate. */
const HUGE_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 3000000) SELECT x FROM c';

describe('a write the callback abandons by its own signal (spec 2026-09-11, R1-R3)', () => {
  // Falsifiable: in `settled`, `await worker.quiesce()` before rethrowing the
  // own abort — the rejection then arrives when the write ends, and the next
  // statement waits for nothing. Holds on every build: the promise rejects at
  // the deadline whether or not the underlying step can be cut, so this no
  // longer loops over VFS (spec 2026-09-15, A5).
  it('rejects at the deadline, and the next statement pays for the rest (T2)', async () => {
    const db = await setUp();
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

  // Falsifiable: in `entryWait`, await `abandoned` without racing the
  // waiting statement's own signal — the rejection still arrives (`own`'s
  // pre-checked `throwIfAborted()` catches it once the wait ends), but only
  // once the abandoned write itself has finished: `rejectedAfter` then costs
  // the whole remaining run and `nextWaited` costs nothing, so the timing
  // assertion below inverts instead of the outcome silently staying green.
  // Holds on every build (see T2's note).
  it('rejects a statement that times out behind an abandoned write, alone (T5)', async () => {
    const db = await setUp();
    try {
      let second: unknown;
      let rejectedAfter = 0;
      let nextWaited = 0;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        await tx.write(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
        const t0 = performance.now();
        second = await tx
          .write('INSERT INTO t VALUES (9)', [], { timeout: 20 })
          .catch((e) => e);
        const t1 = performance.now();
        rejectedAfter = t1 - t0;
        await tx.write('INSERT INTO t VALUES (2)');
        nextWaited = performance.now() - t1;
      });
      expect(second).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 20,
      });
      expect(rejectedAfter).toBeLessThan(nextWaited);
      expect(await rowsOf(db)).toEqual([0, 1, 2]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  }, 60_000);

  // Falsifiable: make commitNow() send its COMMIT with `exec(worker, …)`
  // instead of `via(false)` — the COMMIT then carries no undo and the
  // million rows are committed. Holds on every build (see T2's note).
  it('commits only what preceded a caught abandoned write when the callback returns at once (T6)', async () => {
    const db = await setUp();
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

  // On a build that can cut a step: the rejection escapes, the transaction
  // dies, and the background write is cut rather than awaited. Falsifiable:
  // start the savepointed write with `{ ...given, signal: undefined }` in
  // `settled` — the death then cannot cut it and transaction() waits for the
  // whole write.
  it('cuts the write, keeps nothing, and aborts tx.signal when the rejection escapes (T3)', async () => {
    const db = await setUp({ needs: ['interruptible'] });
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
      // A write that is not cut runs to about `natural`; one that is cut ends
      // well before it. 0.8, not 0.5: OPFSWriteAheadVFS/async cuts later than
      // OPFSAdaptiveVFS/async on Chromium (≈0.6 of natural, 2026-09-15) and
      // the subject is that the write is cut, not how fast.
      expect(took).toBeLessThan(natural * 0.8);
      expect(seen.aborted).toBe(true);
      expect(seen.reason).toBe(reason);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 120_000);

  // No falsifier known. T3's was run here on 2026-09-15 and refuted: with
  // `needs` dropped, on the uninterruptible OPFSWriteAheadVFS/sync pair, T4
  // stayed green on both Chromium projects. Its `took` bound measures how fast
  // the transaction rejects against its own 150 ms timeout, not whether the
  // background write was cut. `needs: ['interruptible']` stays: the subject is
  // a build that can cut a step.
  it("cuts an abandoned write when the transaction's own timeout expires (T4)", async () => {
    const db = await setUp({ needs: ['interruptible'] });
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
      expect(outcome).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 150,
      });
      // A write that is not cut runs to about `natural`; one that is cut ends
      // well before it. 0.8, not 0.5: OPFSWriteAheadVFS/async cuts later than
      // OPFSAdaptiveVFS/async on Chromium (≈0.6 of natural, 2026-09-15) and
      // the subject is that the write is cut, not how fast.
      expect(took).toBeLessThan(natural * 0.8);
      expect(await rowsOf(db)).toEqual([0]);
      expect(await bigCount(db)).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe('a write issued through a generator (spec 2026-09-11, §4)', () => {
  // Falsifiable: in `releasing`, drop the abandon(…) call — the write is
  // then closed like any generator: cut where a step can be cut (the
  // transaction dies), committed where it cannot. Holds on every build (T2's
  // note in the describe above): the promise rejects at the deadline either
  // way, so this no longer loops over VFS (spec 2026-09-15, A5).
  it('undoes a caught write issued through tx.chunk(), and goes on', async () => {
    const db = await setUp();
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
});

describe('a load the callback abandons (spec 2026-09-11, R4, D6)', () => {
  // One savepoint per batch: a load abandoned after its first batch keeps
  // that batch. Deterministic: with `queueSize` one batch, the enqueue that
  // completes batch 1 parks until batch 1 has settled. Falsifiable: restore
  // the `onAbandoned` hook in src/bulk.ts — the transaction then dies and
  // nothing is kept.
  it('keeps the batches an abandoned tx.bulkWrite completed (T9)', async () => {
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

describe("a consumer's own savepoints (spec 2026-09-11, D7, D8)", () => {
  // Falsifiable: drop `!isTransactionControl(sql)` from opensSavepoint() — the
  // timed RELEASE u then runs inside __bsq_sp and pops it, and the COMMIT's
  // RELEASE __bsq_sp fails.
  it('undoes to the consumer savepoint across a caught abandoned write (T8)', async () => {
    const db = await setUp();
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

  // F2 (2026-09-11 final review): the reachable scenario the controller
  // ruling names. D8 checks only the LEADING keyword of the whole
  // statement, so this abandoned write — `BIG_INSERT; RELEASE u` — still
  // counts as savepointed; run to its end (R1), its trailing `RELEASE u`
  // pops __bsq_sp along with `u` (RELEASE releases every savepoint opened
  // after the named one too), so the next message's `ROLLBACK TO __bsq_sp`
  // fails with "no such savepoint". Before this fix only that one statement
  // rejected and the callback's own catch swallowed it, so COMMIT kept the
  // abandoned rows; the worker's own ROLLBACK now takes the whole
  // transaction down through D6 instead. Falsifiable: remove the worker's
  // ROLLBACK from the conclude/open catch in src/worker/worker.ts — the
  // transaction then resolves and the abandoned rows are committed.
  it('dies when an abandoned write pops a consumer savepoint along with __bsq_sp', async () => {
    const db = await setUp();
    try {
      const before = workerIdentity(db);
      let firstCaught: unknown;
      let secondCaught: unknown;
      const outcome = await db
        .transaction(async (tx) => {
          await tx.write('SAVEPOINT u');
          await tx.write('INSERT INTO t VALUES (1)');
          firstCaught = await tx
            .write(`${BIG_INSERT}; RELEASE u`, [], { timeout: 30 })
            .catch((e) => e);
          secondCaught = await tx
            .write('INSERT INTO t VALUES (2)')
            .catch((e) => e);
        })
        .catch((e) => e);
      expect(firstCaught).toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 30,
      });
      expect((secondCaught as Error).message).toMatch(/no such savepoint/);
      // Spec 2026-09-14 §5.1: the worker issues a ROLLBACK after this failure
      // and before replying, which resets the connection's error code to 0.
      // "no such savepoint" has no subtype, so a correct read equals
      // sqliteCode and D9 drops it. Falsifiable: read sqlite3_extended_errcode
      // while building the reply instead of stamping it where the statement
      // failed — it finds 0, which differs from 1 and is kept.
      expect(secondCaught).toMatchObject({
        code: 'STATEMENT_FAILED',
        sqliteCode: SQLITE_CODES.ERROR,
      });
      expect(
        (secondCaught as { sqliteExtendedCode?: number }).sqliteExtendedCode,
      ).toBeUndefined();
      expect(outcome).toBe(secondCaught);
      expect(await bigCount(db)).toBe(0);
      expect(await rowsOf(db)).toEqual([0]);
      expect(workerIdentity(db)).toBe(before);
    } finally {
      await db.close();
    }
  }, 60_000);
});
