import { describe, expect, it } from '@rstest/core';
import { createTestClient, sleep } from './helpers';

const ROWS = 4000;
const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${ROWS}) ` +
  'SELECT x FROM c';

const seed = async (db: Awaited<ReturnType<typeof createTestClient>>) => {
  await db.write('CREATE TABLE t (n INTEGER)');
  await db.write(SEED);
};

/**
 * Whether the pool served a read within `ms`.
 *
 * The read is given a rejection sink before it is raced: against a wedged pool
 * it never settles, and at `close()` it rejects — long after this function has
 * returned, and outside any test if nothing is listening.
 */
const servesWithin = (
  db: Awaited<ReturnType<typeof createTestClient>>,
  ms: number,
) => {
  const read = db.read('SELECT 1 AS ok').then(() => true);
  read.catch(() => {});
  return Promise.race([read, sleep(ms).then(() => false)]);
};

/** Takes one chunk and drops the generator: no break, no return(), no throw. */
const abandon = async (make: () => AsyncGenerator<unknown>) => {
  const rows = make();
  await rows.next();
  await sleep(0);
};

describe('an abandoned generator gives its worker back', () => {
  it('at the deadline, when the caller set a timeout', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      await abandon(() =>
        db.chunk('SELECT n FROM t', [], { chunkSize: 10, timeout: 2000 }),
      );

      // poolSize 1: the only worker is leased and parked between two step()
      // calls. Before the deadline nothing may be served — this half is what
      // proves the leak is real rather than assuming it.
      expect(await servesWithin(db, 300)).toBe(false);

      // After it, the reclaim has run and the pool serves again.
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('at once, when the caller aborts the signal', async () => {
    const controller = new AbortController();
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      await abandon(() =>
        db.stream('SELECT n FROM t', [], {
          chunkSize: 10,
          signal: controller.signal,
        }),
      );

      expect(await servesWithin(db, 300)).toBe(false);
      controller.abort(new Error('the consumer changed its mind'));
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('leaves a correct consumer untouched', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      let seen = 0;
      for await (const rows of db.chunk<{ n: number }>('SELECT n FROM t', [], {
        chunkSize: 500,
      })) {
        seen += rows.length;
        // A streaming test must await in its loop body: consuming at full
        // speed exercises only the transport's happy interleaving.
        await sleep(0);
      }
      expect(seen).toBe(ROWS);
      expect(await servesWithin(db, 8000)).toBe(true);
    } finally {
      await db.close();
    }
  }, 30_000);
});

describe('a reclaim that arrives late', () => {
  /**
   * The mirror image of this file's other tests, and a regression: a cleanup
   * that fires after the worker has moved on must touch nothing.
   *
   * The transaction below abandons a generator whose query has already sent
   * `done`, so `deferredChunk` is clear and the reuse guard is NOT tripped:
   * the next statement runs, the transaction commits, and the lease goes back
   * to the pool with a stale transport still suspended at its `yield` and the
   * caller's abort listener still armed. When the caller later tidies up its
   * own controller, the cleanup that fires belongs to a query that ended long
   * ago — and the worker is serving somebody else.
   *
   * Before the fix the abort reached the live query: `interrupt()` broke its
   * loop and the consumer received `done` with 100 of 4000 rows and no error.
   */
  it('does not truncate the query the worker has moved on to', async () => {
    const controller = new AbortController();
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);

      await db.transaction(async (tx) => {
        const rows = tx.chunk('SELECT n FROM t LIMIT 1', [], {
          chunkSize: 10,
          signal: controller.signal,
        });
        // One chunk, then the generator is dropped. `done` has already
        // cleared deferredChunk while the drain sits at its yield.
        await rows.next();
        await sleep(50);
        // The guard is not tripped, and this is the point: the transaction
        // ends normally, which is what leaves the stale transport behind.
        const ok = await tx.read<{ ok: number }>('SELECT 1 AS ok');
        expect(ok[0]?.ok).toBe(1);
      });

      let seen = 0;
      for await (const rows of db.chunk<{ n: number }>('SELECT n FROM t', [], {
        chunkSize: 10,
      })) {
        seen += rows.length;
        // A streaming test must await in its loop body.
        await sleep(1);
        if (seen === 100)
          controller.abort(new Error('the caller tidies up its controller'));
      }
      expect(seen).toBe(ROWS);
    } finally {
      await db.close();
    }
  }, 60_000);
});
