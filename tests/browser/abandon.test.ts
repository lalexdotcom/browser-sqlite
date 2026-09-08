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
