import { describe, expect, it } from 'vitest';
import { createTestClient, scaled } from '../helpers';

/**
 * spec 2026-09-11 on the one configuration the ordinary projects cannot reach:
 * the `sync` build under cross-origin isolation, where the abort slot CAN cut
 * a running step — so a savepointed write must not be cut by its own signal,
 * and must be cut by the transaction's death.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

const setUp = async () => {
  const db = await createTestClient({
    poolSize: 1,
  });
  await db.run('CREATE TABLE t (a INTEGER)');
  await db.run('CREATE TABLE big (x INTEGER)');
  await db.run('INSERT INTO t VALUES (0)');
  return db;
};

describe('a savepointed write on the sync isolated build (spec 2026-09-11)', {
  tags: ['build:sync', 'requires:interruptible'],
}, () => {
  // Falsifiable: drive the savepointed write with the merged signal in
  // `settled` (`start(via(true, mark), options)`) — the slot then cuts it,
  // SQLite rolls the transaction back, and it dies.
  it(
    'undoes a caught abandoned write, and the transaction goes on',
    async () => {
      const db = await setUp();
      try {
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          await tx.run(BIG_INSERT, [], { timeout: 30 }).catch(() => {});
          await tx.run('INSERT INTO t VALUES (2)');
        });
        expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([
          { a: 0 },
          { a: 1 },
          { a: 2 },
        ]);
        expect(await db.all('SELECT count(*) AS n FROM big')).toEqual([
          { n: 0 },
        ]);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );

  // Falsifiable: in `settled`, stop racing `running` against the own-abort
  // signal (`return await running;` unconditionally) — `tx.run` then waits
  // for BIG_INSERT to finish instead of rejecting at 30 ms, nothing ever
  // escapes the callback, and the transaction commits every abandoned row.
  it(
    'keeps nothing when the rejection escapes',
    async () => {
      const db = await setUp();
      try {
        const reason = new Error('abandon the write');
        await expect(
          db.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            const ctl = new AbortController();
            setTimeout(() => ctl.abort(reason), 30);
            await tx.run(BIG_INSERT, [], { signal: ctl.signal });
          }),
        ).rejects.toBe(reason);
        expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([{ a: 0 }]);
        expect(await db.all('SELECT count(*) AS n FROM big')).toEqual([
          { n: 0 },
        ]);
      } finally {
        await db.close();
      }
    },
    scaled(60_000),
  );
});
