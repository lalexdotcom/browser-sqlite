import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

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
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

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
          caught = await tx
            .write(BIG_INSERT, [], { signal: abortAfter(30, reason) })
            .catch((e) => e);
          later = await tx.read('SELECT a FROM t').catch((e) => e);
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(caught).toBe(reason);
      expect(later).toMatchObject({ code: 'TRANSACTION_CLOSED' });
      expect((later as Error).cause).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
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
          await tx
            .write(BIG_INSERT, [], { signal: abortAfter(30, reason) })
            .catch(() => {});
          await tx.write('INSERT INTO t VALUES (2)').catch(() => {});
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  // Spec 2026-09-10, D4 reversed: a write whose own signal is already
  // aborted at the call never reaches the worker, so it rejects alone — the
  // callback catches it exactly as for any other error, and the transaction
  // goes on to commit both other rows.
  it('rejects a write whose signal was already aborted, and the transaction goes on', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('never started');
      const ctl = new AbortController();
      ctl.abort(reason);
      let refused: unknown;
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        refused = await tx
          .write('INSERT INTO t VALUES (2)', [], { signal: ctl.signal })
          .catch((e) => e);
        await tx.write('INSERT INTO t VALUES (3)');
      });

      expect(refused).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 3 },
      ]);
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
          caught = await tx
            .write(BIG_INSERT, [], { timeout: 30 })
            .catch((e) => e);
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
        await tx
          .read(slow, [], {
            signal: abortAfter(30, new Error('this read only')),
          })
          .catch(() => {});
        await tx.write('INSERT INTO t VALUES (2)');
      });
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 2 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

  // Falsifiable: as for the read above — the SQL is the discriminator (D5).
  // In-flight, not pre-aborted (D5): the pre-aborted version's falsifier
  // (discriminate on the method instead of the SQL) did not flip it, since a
  // pre-aborted write never reaches withSignal's catch at all. This cuts a
  // running step instead, on OPFSAdaptiveVFS's async build.
  // Falsifiable: make isAbandonedWrite() discriminate on the METHOD instead
  // of the SQL (e.g. `method === 'write'` in place of `isWriteQuery(sql)`).
  it('abandons the transaction for a write issued through tx.first()', async () => {
    const db = await setUp({ vfs: 'OPFSAdaptiveVFS' });
    try {
      const reason = new Error('cut mid-step');
      let caught: unknown;
      const finished = deferred();
      await expect(
        db.transaction(async (tx) => {
          caught = await tx
            .first(`${BIG_INSERT} RETURNING x`, [], {
              signal: abortAfter(30, reason),
            })
            .catch((e) => e);
          finished.resolve();
        }),
      ).rejects.toBe(reason);
      await finished.promise;

      expect(caught).toBe(reason);
      expect(await db.read('SELECT count(*) AS n FROM big')).toEqual([
        { n: 0 },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

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

  // Spec 2026-09-10, D4 reversed: a bulkWrite created with a signal already
  // aborted writes nothing and rejects alone — no `abandon` listener is even
  // registered for it (src/bulk.ts) — so the transaction goes on.
  // Falsifiable: register the `abandon` listener unconditionally in
  // src/bulk.ts's bulkWrite, as before — the transaction dies instead.
  it('rejects a tx.bulkWrite created with an aborted signal, and the transaction goes on', async () => {
    const db = await setUp({ vfs: 'MemoryVFS' });
    try {
      const reason = new Error('never started');
      const ctl = new AbortController();
      ctl.abort(reason);
      let refused: unknown;

      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
        const writer = tx.bulkWrite('t', ['a'], { signal: ctl.signal });
        try {
          writer.enqueue({ a: 2 });
        } catch (e) {
          refused = e;
        }
        await tx.write('INSERT INTO t VALUES (3)');
      });

      expect(refused).toBe(reason);
      expect(await db.read('SELECT a FROM t ORDER BY a')).toEqual([
        { a: 0 },
        { a: 1 },
        { a: 3 },
      ]);
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
          const out = tx.output(
            'target',
            { a: 'INTEGER' },
            { signal: ctl.signal },
          );
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
});
