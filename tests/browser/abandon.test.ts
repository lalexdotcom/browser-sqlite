import { describe, expect, it } from '@rstest/core';
import { createLogger } from '../../src/logger';
import { createPoolWorker, type PoolWorker } from '../../src/pool';
import {
  createTestClient,
  removeDatabaseFiles,
  sleep,
  TEST_TARGET,
} from './helpers';

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
    const db = await createTestClient({ poolSize: 1 });
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
    const db = await createTestClient({ poolSize: 1 });
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
    const db = await createTestClient({ poolSize: 1 });
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
    const db = await createTestClient({ poolSize: 1 });
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

describe("interrupt() ignores a transport the worker isn't serving", () => {
  /**
   * A1's own scenario, without transaction(), chunk(), AbortController or the
   * seeded table above: this pins `src/pool.ts`'s identity check — the fix
   * itself — directly, rather than only as one of several things that has to
   * work for "a reclaim that arrives late" to pass.
   *
   * There is no Node-unit route to this: `createPoolWorker` spawns a real
   * `Worker`, so the rule can only be exercised where one exists. But
   * `createPoolWorker` is already exported for `src/client.ts`'s own use, so
   * reaching it directly needs no change to `src/pool.ts` and no test-only
   * seam — it is the same constructor `client.ts` calls, called once instead
   * of through the whole pool/scheduler/client stack.
   *
   * The scenario: run one query to its own completion — the `done` message
   * clears `deferredChunk`, satisfying the reuse guard — while never resuming
   * its transport past the affected-count `yield`. A second query then claims
   * the worker. `interrupt()` named at the FIRST (stale) transport must not
   * touch the SECOND (live) one — the exact shape A1 found inside a
   * transaction, reproduced here with none of it.
   */
  it('does not stop the live query when named the stale one', async () => {
    const pool: (PoolWorker | undefined)[] = [];
    // Short on purpose: sqlite3_open_v2 checks nPathname + 8 > mxPathname
    // (64, wa-sqlite/src/VFS.js:10), so a name near that budget fails
    // open() for a reason that has nothing to do with this test.
    const file = `pid-${Date.now().toString(36)}`;
    const opened = await createPoolWorker({
      index: 0,
      pool,
      clientName: 'pool-interrupt-direct',
      file,
      vfs: TEST_TARGET.vfs,
      build: TEST_TARGET.build,
      drainTimeout: 5000,
      logger: createLogger('test', false),
    });
    // No declineWithout is passed above, so a decline here means the harness
    // itself is broken, not the scenario under test.
    if ('declined' in opened)
      throw new Error(`worker declined to open: no ${opened.declined}`);
    const worker = opened;
    try {
      // Drain the stale transport to its own "done" — the affected count —
      // and stop there, never calling next() again. The WORKER now considers
      // the query finished (deferredChunk is clear); the TRANSPORT does not.
      const stale = worker.query('SELECT 1');
      let affected: unknown;
      // Bounded: a transport that ends without ever yielding its affected
      // count would otherwise spin here for the whole test timeout and report
      // nothing. `SELECT 1` yields one chunk and one count, so 10 turns is
      // already an order of magnitude of slack.
      let turns = 0;
      do {
        if (turns++ > 10)
          throw new Error(
            `the transport never yielded an affected count (last value: ${String(affected)})`,
          );
        ({ value: affected } = await stale.next());
      } while (typeof affected !== 'number');
      expect(affected).toBe(0);

      // The reuse guard admits a second query on the same worker, which
      // claims `servingQuery` on ITS OWN first next().
      const live = worker.query<{ n: number }>('SELECT 1 AS n');
      expect((await live.next()).value).toEqual([{ n: 1 }]);

      // Named at the stale transport, as if from a reclaim() arriving late.
      worker.interrupt(stale);

      // The live query is unaffected: it still runs to its own completion.
      const second = await live.next();
      expect(typeof second.value).toBe('number');
    } finally {
      // close() posts `close` and waits for the reply; terminating is the
      // caller's own job (src/pool.ts's PoolWorker). Nothing else owns this
      // worker — it was built here rather than by a client — so without the
      // terminate every run of this suite leaks one Worker. And with no
      // client's own afterEach behind it, the OPFS file it may have opened
      // (TEST_TARGET.vfs, unlike the MemoryVFS this used to pin) needs its
      // own cleanup.
      await worker.close();
      worker.terminate();
      await removeDatabaseFiles(file, TEST_TARGET.vfs);
    }
  });
});
