import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, sleep } from './helpers';

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
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      await db.transaction(async (tx) => {
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

      // The client still serves, and the seeded rows are intact — a real
      // read of table data, not a vacuous `SELECT 1`.
      const rows = await db.read<{ n: number }>('SELECT count(*) AS n FROM t');
      expect(rows[0]?.n).toBe(2000);
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
});

// What no test here can reach: the `onAbandon: release` added to
// src/transaction.ts repairs the case where the transaction has ENDED and its
// pending `quiesce()` would never settle — which needs a garbage collection to
// observe. Nothing in this file pins that; removing `onAbandon: release` turns
// nothing in this suite red.
