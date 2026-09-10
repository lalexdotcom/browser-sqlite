import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery, sleep } from './helpers';

/**
 * A statement's own `timeout` inside a transaction, bounding it exactly like a
 * per-statement `signal` does: the statement rejects alone, uncaught it rolls
 * the transaction back, caught it lets the callback continue to COMMIT. Reads
 * only: a write abandoned by its own timeout abandons the whole transaction,
 * which tests/browser/tx-abort.test.ts pins.
 *
 * `longQuery` is a single-row aggregate: on the `sync` build with no
 * cross-origin isolation (both engines, in this suite) worker.ts installs no
 * progress handler at all, so the recursive CTE runs to completion in one
 * uninterruptible step() regardless of the timeout. The size below (2 000 000)
 * is chosen so that natural completion is comfortably above the 200 ms budget
 * on both engines (~500 ms Chromium, ~2.3 s Firefox, measured) while staying
 * well inside each test's own timeout.
 */
describe('a statement timeout inside a transaction', () => {
  it('rejects the transaction, uncaught, and rolls back an earlier write', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');

      await expect(
        db.transaction(async (tx) => {
          await tx.write('INSERT INTO t VALUES (1)');
          await tx.read(longQuery(2_000_000), [], { timeout: 200 });
        }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });

      expect(await db.read('SELECT a FROM t')).toEqual([]);
    } finally {
      await db.close();
    }
  }, 15000);

  it('lets the callback catch the timeout and continue to COMMIT', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');

      let caughtCode: string | undefined;
      await db.transaction(async (tx) => {
        try {
          await tx.read(longQuery(2_000_000), [], { timeout: 200 });
        } catch (error) {
          caughtCode = (error as { code?: string }).code;
        }
        await tx.write('INSERT INTO t VALUES (1)');
      });

      expect(caughtCode).toBe('OPERATION_TIMEOUT');
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  }, 15000);

  it('rejects a tx.chunk() whose consumer pauses past the timeout between chunks', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (x INTEGER)');
      await db.write(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ' +
          'INSERT INTO t SELECT x FROM c',
      );

      await expect(
        db.transaction(async (tx) => {
          for await (const rows of tx.chunk<{ x: number }>(
            'SELECT x FROM t',
            [],
            {
              timeout: 100,
            },
          )) {
            void rows;
            // A streaming consumer that never pauses tests nothing here: the
            // credit window keeps a chunk in flight regardless of the timeout.
            await sleep(150);
          }
        }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 100 });
    } finally {
      await db.close();
    }
  }, 15000);
});
