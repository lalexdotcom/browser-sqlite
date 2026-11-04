import { describe, expect, it } from 'vitest';
import { createTestClient, longQuery, scaled, sleep } from '../helpers';

/**
 * A statement's own `timeout` inside a transaction, bounding it exactly like a
 * per-statement `signal` does: the statement rejects alone, uncaught it rolls
 * the transaction back, caught it lets the callback continue to COMMIT. Reads
 * only: a write abandoned by its own timeout abandons the whole transaction,
 * which tests/browser/tx-abort.test.ts pins.
 *
 * `longQuery` is a single-row aggregate: on a `sync` build with no
 * cross-origin isolation, worker.ts installs no progress handler at all, so
 * the recursive CTE runs to completion in one uninterruptible step()
 * regardless of the timeout; on `async`/`jspi` a statement with a timeout
 * yields periodically and can actually be cut (mem:vfs, HANDLE-1). Either
 * way the transaction's own deadline rejects on schedule, which is the whole
 * subject here — the test follows the target (spec 2026-09-15, A5), no
 * `needs` declared. The size below (2 000 000) is chosen so that natural
 * completion is comfortably above the 200 ms budget on both engines (~500 ms
 * Chromium, ~2.3 s Firefox, measured on `sync`) while staying well inside
 * each test's own timeout even when the statement is not actually cut.
 */
describe('a statement timeout inside a transaction', () => {
  it(
    'rejects the transaction, uncaught, and rolls back an earlier write',
    async () => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (a INTEGER)');

        await expect(
          db.transaction(async (tx) => {
            await tx.run('INSERT INTO t VALUES (1)');
            await tx.all(longQuery(2_000_000), [], { timeout: 200 });
          }),
        ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT', timeout: 200 });

        expect(await db.all('SELECT a FROM t')).toEqual([]);
      } finally {
        await db.close();
      }
    },
    scaled(15000),
  );

  it(
    'lets the callback catch the timeout and continue to COMMIT',
    async () => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (a INTEGER)');

        let caughtCode: string | undefined;
        // What the next red must say (Windows Firefox, 2026-11-04, run
        // 41847018002: `undefined`, nothing else known): whether all()
        // resolved or threw something without a code, and after how long —
        // a page timer fired late, or another error.
        let outcome = 'resolved';
        await db.transaction(async (tx) => {
          const started = performance.now();
          try {
            const rows = await tx.all(longQuery(2_000_000), [], {
              timeout: 200,
            });
            outcome = `resolved with ${rows.length} row(s)`;
          } catch (error) {
            caughtCode = (error as { code?: string }).code;
            outcome = `threw ${String(error)}`;
          } finally {
            outcome += ` after ${Math.round(performance.now() - started)} ms`;
          }
          await tx.run('INSERT INTO t VALUES (1)');
        });

        expect(caughtCode, outcome).toBe('OPERATION_TIMEOUT');
        expect(await db.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
      } finally {
        await db.close();
      }
    },
    scaled(15000),
  );

  it(
    'rejects a tx.chunk() whose consumer pauses past the timeout between chunks',
    async () => {
      const db = await createTestClient({ poolSize: 1 });
      try {
        await db.run('CREATE TABLE t (x INTEGER)');
        await db.run(
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
    },
    scaled(15000),
  );
});
