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
});
