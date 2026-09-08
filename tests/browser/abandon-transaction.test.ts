import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createTestClient, sleep } from './helpers';

const SEED =
  'INSERT INTO t (n) WITH RECURSIVE c(x) AS ' +
  '(SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000) ' +
  'SELECT x FROM c';

describe('an abandoned generator inside a transaction', () => {
  it('fails the transaction with GENERATOR_ABANDONED, not a bare Error', async () => {
    // NOT MemoryVFS. The pool size here is incidental — the reason is the VFS.
    //
    // (Retraction: an earlier draft of this comment argued for a pool of two
    // on the grounds that a single worker would make the supervisor's verdict
    // fail-client rather than restart. That is false: src/supervisor.ts's
    // 'died' handler restarts a first death of a slot that has already served
    // queries — `if (slot.everReady && slot.restarts < maxWorkerRestarts)
    // return 'restart'` — without consulting the live worker count at all;
    // the count only decides between 'lost' and 'fail-client' further down,
    // once the restart budget is spent. So poolSize: 1 would also restart.
    // Kept here rather than silently deleted, per this repository's
    // convention of keeping refutations.)
    //
    // The real reason: MemoryVFS is volatile and single-connection, so a
    // worker evicted and restarted after GENERATOR_ABANDONED comes back with
    // an EMPTY database. This test's closing assertion — that the client
    // still serves — reads `SELECT 1 AS ok`, which touches no table data, so
    // against MemoryVFS it would pass vacuously even if the restarted
    // connection had lost everything. The default (persistent) VFS makes the
    // restarted slot reopen the same database file, so the assertion means
    // what it appears to mean.
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
