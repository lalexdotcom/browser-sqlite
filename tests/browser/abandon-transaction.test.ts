import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTestClient, sleep } from './helpers';

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) ' +
  'SELECT x FROM c';

describe('an abandoned generator inside a transaction', () => {
  it('fails the transaction with GENERATOR_ABANDONED, not a bare Error', async () => {
    // NOT MemoryVFS at poolSize 1. This test's last assertion is that the
    // client survives, and the guard's failure path evicts the worker: with
    // one worker the supervisor's verdict is fail-client, not restart. The
    // default VFS takes a pool of two, so the slot restarts beside a live one.
    const db = await createTestClient({ poolSize: 2 });
    try {
      await db.write('CREATE TABLE t (n INTEGER)');
      await db.write(SEED);

      const failure = await db
        .transaction(async (tx) => {
          const rows = tx.chunk('SELECT n FROM t', [], { chunkSize: 10 });
          await rows.next();
          await sleep(0);
          // The generator is abandoned here. The auto-COMMIT is itself a
          // statement on the same worker, so it trips the reuse guard long
          // before any collection could run — which is the ordinary
          // trajectory, and the one this assertion pins.
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(SQLiteError);
      expect((failure as SQLiteError).code).toBe('GENERATOR_ABANDONED');
      // The message must tell the consumer what to do, not name an invariant.
      expect((failure as SQLiteError).message).toContain('break');

      // The client survives: the worker was evicted and the slot restarted.
      const rows = await db.read<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
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
