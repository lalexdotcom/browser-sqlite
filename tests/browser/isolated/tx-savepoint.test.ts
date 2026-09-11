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
