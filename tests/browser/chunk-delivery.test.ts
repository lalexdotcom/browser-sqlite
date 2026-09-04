import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

/**
 * A consumer that awaits between chunks must still receive every row.
 *
 * The credit window lets the worker send several chunks before it waits, but
 * the transport used to hold ONE slot for them: a chunk arriving while the
 * pool's generator was suspended at its `yield` resolved a promise nobody
 * would ever await, and the generator then waited on the fresh one. The chunk
 * was gone, silently — no error, no short read, just fewer rows.
 *
 * Measured before the fix, deterministic across 5 runs on both engines: 501 of
 * 1001 rows for a consumer that awaited anything at all between chunks. The
 * `setTimeout(0)` in the second test is not a stand-in for slow work — one turn
 * of the event loop was the whole precondition.
 *
 * `read()`, `first()` and `write()` never lost a row and still must not: they
 * accumulate inside the library without handing control back between chunks,
 * which is exactly why the defect stayed invisible for four releases.
 */
const ROWS = 1001;

const seed = async (
  db: Awaited<ReturnType<typeof createTestClient>>,
  rows = ROWS,
) => {
  await db.write('CREATE TABLE t (a INTEGER)');
  await db.write(
    `INSERT INTO t SELECT x FROM (WITH RECURSIVE c(x) AS ` +
      `(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT x FROM c)`,
  );
};

/**
 * Enough chunks that the query is unmistakably still in flight when the tests
 * below fire their event. At 1001 rows the whole result — `done` included —
 * arrives inside the consumer's first pause, and a transport failure announced
 * afterwards is moot by construction: everything had already been delivered.
 * That is correct behaviour and it is why the first draft of these two tests
 * failed against a correct fix.
 */
const MANY = 20_000;

describe('chunk delivery', () => {
  it('delivers every chunk to a consumer that pauses between them', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      let rows = 0;
      let chunks = 0;
      for await (const chunk of db.chunk<{ a: number }>('SELECT a FROM t')) {
        chunks++;
        rows += chunk.length;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(rows).toBe(ROWS);
      expect(chunks).toBeGreaterThan(1);
    } finally {
      await db.close();
    }
  });

  it('delivers every row to a stream consumer that awaits per row', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      const seen: number[] = [];
      for await (const row of db.stream<{ a: number }>('SELECT a FROM t')) {
        seen.push(row.a);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(seen.length).toBe(ROWS);
      // Order matters as much as the count: a dropped chunk leaves a gap
      // rather than a short tail, and a count alone would not see a
      // re-ordering that delivered the right number of wrong rows.
      expect(seen[0]).toBe(1);
      expect(seen[seen.length - 1]).toBe(ROWS);
    } finally {
      await db.close();
    }
  });

  it('still delivers every row to a consumer that never pauses', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await seed(db);
      let rows = 0;
      for await (const chunk of db.chunk<{ a: number }>('SELECT a FROM t')) {
        rows += chunk.length;
      }
      expect(rows).toBe(ROWS);
      expect((await db.read('SELECT a FROM t')).length).toBe(ROWS);
      expect(await db.first('SELECT a FROM t')).toEqual({ a: 1 });
    } finally {
      await db.close();
    }
  });

  /**
   * The three promises the delivery loop races besides a chunk — a requested
   * stop, an undeserializable message, and the worker's death — each fired
   * while the consumer is SUSPENDED between two chunks. That state is the one
   * the delivery loop changed, and the existing suite reaches none of these
   * paths from it: `lifecycle.test.ts` fires its `messageerror` at a query
   * that is still stepping and has produced no chunk at all.
   *
   * These three are GUARDS, not regression tests, and the distinction matters
   * to whoever reads a failure here: they pass against the defective code too,
   * because the three channels were never what broke. They exist because the
   * fix moved them out of the race and behind flags — a delivery loop that
   * drains a full inbox never awaits, so it would never look at them again.
   * The first version of this fix did exactly that, and one of these tests is
   * what found it. The regression tests for the defect itself are the three
   * delivery tests above.
   */
  describe('while the consumer is suspended between chunks', () => {
    it('stops on an early break, and hands the worker back', async () => {
      const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
      try {
        await seed(db);
        let chunks = 0;
        for await (const _chunk of db.chunk<{ a: number }>('SELECT a FROM t')) {
          chunks++;
          await sleep(50);
          break;
        }
        expect(chunks).toBe(1);
        // The lease came back and the worker is serving again: a delivery loop
        // that exited without stopping-and-draining would leave it stepping.
        expect(await db.read('SELECT count(*) AS n FROM t')).toEqual([
          { n: ROWS },
        ]);
      } finally {
        await db.close();
      }
    });

    it('rejects on an undeserializable message', async () => {
      const records = interceptWorkers();
      const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
      try {
        await seed(db, MANY);
        const consuming = (async () => {
          for await (const _chunk of db.chunk<{ a: number }>(
            'SELECT a FROM t',
          )) {
            await sleep(50);
          }
        })();
        await sleep(120); // inside the first pause, after the first chunk
        records[0]?.worker.dispatchEvent(new MessageEvent('messageerror'));
        await expect(consuming).rejects.toMatchObject({
          code: 'PROTOCOL_ERROR',
        });
      } finally {
        await db.close();
      }
    });

    it('rejects when the worker dies', async () => {
      const records = interceptWorkers();
      const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
      try {
        await seed(db, MANY);
        const consuming = (async () => {
          for await (const _chunk of db.chunk<{ a: number }>(
            'SELECT a FROM t',
          )) {
            await sleep(50);
          }
        })();
        await sleep(120);
        records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
        await expect(consuming).rejects.toMatchObject({
          code: 'WORKER_CRASHED',
        });
      } finally {
        await db.close();
      }
    });
  });
});
