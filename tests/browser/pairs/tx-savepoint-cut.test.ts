import { describe, expect, it } from 'vitest';
import {
  abandonOnceRunning,
  createTestClient,
  exercised,
  scaled,
} from '../helpers';

/**
 * spec 2026-09-11 on the one configuration the ordinary projects cannot reach:
 * the `sync` build under cross-origin isolation, where the abort slot CAN cut
 * a running step — so a savepointed write must not be cut by its own signal,
 * and must be cut by the transaction's death.
 */
/**
 * Finite: a caught abandoned write runs on to its end before it is undone, so
 * the next statement waits for it.
 */
const BIG_INSERT =
  'INSERT INTO big WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000000) SELECT x FROM c';

/**
 * Endless until something ends it: one that escapes the callback is cut by the
 * transaction's death, so it is running when abandoned on any runner.
 */
const ENDLESS_INSERT =
  'INSERT INTO big SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000000) SELECT x FROM c)';

const setUp = async () => {
  const db = await createTestClient({
    poolSize: 1,
    // abandonOnceRunning sees the write running.
    debug: true,
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
        const { signal, abandonedRunning } = abandonOnceRunning(db, BIG_INSERT);
        await db.transaction(async (tx) => {
          await tx.run('INSERT INTO t VALUES (1)');
          await tx.run(BIG_INSERT, [], { signal }).catch(() => {});
          await tx.run('INSERT INTO t VALUES (2)');
        });
        if (
          !(await exercised(
            abandonedRunning(),
            'the write ended before it was seen running',
          ))
        )
          return;
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
  // for the endless write instead of rejecting at its abort, nothing ever
  // escapes the callback, and the test runs out of time.
  it(
    'keeps nothing when the rejection escapes',
    async () => {
      const db = await setUp();
      try {
        const reason = new Error('abandon the write');
        await expect(
          db.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            await tx.run(ENDLESS_INSERT, [], {
              signal: abandonOnceRunning(db, ENDLESS_INSERT, reason).signal,
            });
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
