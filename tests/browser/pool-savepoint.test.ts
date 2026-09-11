import { describe, expect, it } from '@rstest/core';
import { SQLiteError } from '../../src/errors';
import { createLogger } from '../../src/logger';
import {
  createPoolWorker,
  type PoolWorker,
  type PoolWorkerQueryOptions,
} from '../../src/pool';
import { defaultBuildFor } from '../../src/types';

/**
 * The worker half of the savepoint protocol (spec 2026-09-11, §4), reached
 * through `createPoolWorker` directly, as tests/browser/abandon.test.ts does:
 * no transaction.ts is involved, so what is pinned is the worker's order of
 * operations and the moment the pool reads the thunk, nothing above.
 */
const spawn = () =>
  createPoolWorker({
    index: 0,
    pool: [] as (PoolWorker | undefined)[],
    clientName: 'pool-savepoint',
    // Short: sqlite3_open_v2 refuses a name near the VFS's 64-byte path budget.
    file: `psp-${Date.now().toString(36)}`,
    vfs: 'MemoryVFS',
    build: defaultBuildFor('MemoryVFS'),
    drainTimeout: 5000,
    logger: createLogger('test', false),
  });

const run = async (
  worker: PoolWorker,
  sql: string,
  options?: PoolWorkerQueryOptions,
) => {
  const rows: unknown[] = [];
  for await (const chunk of worker.query(sql, [], options))
    if (typeof chunk !== 'number') rows.push(...chunk);
  return rows;
};

describe('the worker concludes, then opens, a savepoint before the statement', () => {
  // Falsifiable: drop the `ROLLBACK TO` line in src/worker/worker.ts — row 2
  // is then committed.
  it('undoes the savepointed statement when the next message says undo', async () => {
    const worker = await spawn();
    try {
      await run(worker, 'CREATE TABLE t (a INTEGER)');
      await run(worker, 'BEGIN');
      await run(worker, 'INSERT INTO t VALUES (1)');
      await run(worker, 'INSERT INTO t VALUES (2)', {
        savepoint: () => ({ open: true }),
      });
      await run(worker, 'INSERT INTO t VALUES (3)', {
        savepoint: () => ({ conclude: 'undo' }),
      });
      await run(worker, 'COMMIT');
      expect(await run(worker, 'SELECT a FROM t ORDER BY a')).toEqual([
        { a: 1 },
        { a: 3 },
      ]);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });

  // Falsifiable: drop the `RELEASE` line — the savepoint survives and the
  // ROLLBACK TO below succeeds instead of failing.
  it('keeps the statement, and closes the savepoint, when the next message says release', async () => {
    const worker = await spawn();
    try {
      await run(worker, 'CREATE TABLE t (a INTEGER)');
      await run(worker, 'BEGIN');
      await run(worker, 'INSERT INTO t VALUES (1)');
      await run(worker, 'INSERT INTO t VALUES (2)', {
        savepoint: () => ({ open: true }),
      });
      await run(worker, 'SELECT 1', {
        savepoint: () => ({ conclude: 'release' }),
      });
      const refused = await run(worker, 'ROLLBACK TO __bsq_sp').catch((e) => e);
      expect((refused as Error).message).toMatch(/no such savepoint/);
      await run(worker, 'COMMIT');
      expect(await run(worker, 'SELECT a FROM t ORDER BY a')).toEqual([
        { a: 1 },
        { a: 2 },
      ]);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });

  // Falsifiable: in src/pool.ts's runQuery, call `savepoint?.()` above the
  // reuse guard — it is then read for a query the guard refuses, and a
  // transaction would lose its pending conclusion to it.
  it('reads the thunk only for a query it actually sends', async () => {
    const worker = await spawn();
    try {
      // Held mid-query: one row delivered, the worker parked on its credit.
      const held = worker.query(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1000) SELECT x FROM c',
        [],
        { chunkSize: 1, credits: 1 },
      );
      await held.next();
      let read = false;
      const refused = await worker
        .query('SELECT 1', [], {
          savepoint: () => {
            read = true;
            return { open: true };
          },
        })
        .next()
        .catch((e) => e);
      expect(refused).toBeInstanceOf(SQLiteError);
      expect((refused as SQLiteError).code).toBe('GENERATOR_ABANDONED');
      expect(read).toBe(false);
      worker.interrupt(held);
      await held.return(undefined);
    } finally {
      await worker.close();
      worker.terminate();
    }
  });
});
