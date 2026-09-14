import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) ' +
  'SELECT x FROM c';

describe('an abandoned generator inside a transaction', () => {
  // Falsifiable: revert closeOpenStatements()'s two call sites in
  // src/transaction.ts. Without them the abandoned generator is still open
  // when the auto-COMMIT runs, which trips pool.ts's reuse guard, fails the
  // ROLLBACK in turn, and gets the worker evicted — turning every assertion
  // below red. No CPU load and no flake needed: the trip is deterministic on
  // the current code, and its absence is deterministic with the fix.
  it('commits, and evicts no worker', async () => {
    const records = interceptWorkers();
    // OPFSAnyContextVFS: it keeps a pool on every engine; OPFSAdaptiveVFS runs
    // one worker without readwrite-unsafe (spec 2026-09-13, §10).
    const db = await createTestClient({
      poolSize: 2,
      vfs: 'OPFSAnyContextVFS',
    });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      await db.transaction(async (tx) => {
        // Written INSIDE the transaction, so the count below can tell a
        // COMMIT from a ROLLBACK. Reading only the seed would leave the two
        // outcomes indistinguishable, and this test is named for the commit.
        await tx.write('INSERT INTO t (n) VALUES (99999)');
        const rows = tx.chunk('SELECT n FROM t', [], { chunkSize: 10 });
        await rows.next();
        await sleep(0);
        // The generator is abandoned here. The transaction closes it before
        // COMMIT, so the auto-COMMIT never meets an in-flight query and the
        // transaction commits normally instead of failing.
      });

      // No worker was terminated, and none was spawned to replace one.
      expect(records.some((record) => record.terminated)).toBe(false);
      expect(records.length).toBe(2);

      // The client still serves, and the transaction's own row landed — 2001,
      // not the 2000 a silent ROLLBACK would leave.
      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0]?.n).toBe(2001);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('leaves a correct transaction untouched', async () => {
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);
      const seen = await db.transaction(async (tx) => {
        let count = 0;
        for await (const rows of tx.chunk<{ n: number }>('SELECT n FROM t')) {
          count += rows.length;
          await sleep(0);
        }
        return count;
      });
      expect(seen).toBe(2000);
    } finally {
      await db.close();
    }
  }, 30_000);

  // C1. Falsifiable: delete `worker.interrupt(transport)` from
  // closeOpenStatements() in src/transaction.ts. A method call on an async
  // generator is QUEUED behind a next() already in flight, so without the
  // interrupt the close-out's `return()` waits for a chunk that this query
  // will not produce for minutes. BEGIN, COMMIT and ROLLBACK carry no signal
  // and no timeout is passed here, so nothing else cuts it: the transaction
  // never rejects, the lease never goes back, and the origin-wide write lock
  // is held throughout. This times out instead of finishing in seconds.
  it('rejects when the callback leaves a next() in flight', async () => {
    // Short on purpose: the worker is inside one uninterruptible step() and
    // will answer no stop, so drainTimeout is what bounds the wait. That
    // bound is the whole point — see closeOpenStatements()'s JSDoc.
    const db = await createTestClient({ poolSize: 2, drainTimeout: 2000 });
    try {
      const started = performance.now();
      await expect(
        db.transaction(async (tx) => {
          // Nothing abortable anywhere: no signal on the transaction, none on
          // the statement, no timeout. The only thing that can settle the
          // next() below is the worker being told to stop.
          const rows = tx.chunk(longQuery(200_000_000));
          // In flight and never awaited — the shape a `Promise.race` that
          // lost its own timer leaves behind.
          void rows.next().catch(() => {});
          await sleep(0);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      // Bounded by drainTimeout, not by the query: 200 million iterations of
      // that CTE run far longer than this budget.
      expect(performance.now() - started).toBeLessThan(15_000);
    } finally {
      await db.close();
    }
  }, 30_000);
});

// What no test here can reach: the `onAbandon: release` added to
// src/transaction.ts repairs the case where the transaction has ENDED and its
// pending `quiesce()` would never settle — which needs a garbage collection to
// observe. Nothing in this file pins that; removing `onAbandon: release` turns
// nothing in this suite red.
