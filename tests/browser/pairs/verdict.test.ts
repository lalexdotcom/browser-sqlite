import { SQLiteError } from 'browser-sqlite';
import { describe, expect, it } from 'vitest';
import type { PoolWorker } from '../../../src/pool';
import {
  createTestClient,
  interceptWorkers,
  killSilently,
  longQuery,
  theQueryIsRunning,
  waitUntil,
} from '../helpers';

/**
 * A worker's verdict on a SQL text — read, write or refused — reached on the
 * `PoolWorker` directly: nothing above the transport asks for one yet.
 */

const SERIES = (n: number) =>
  `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${n}) SELECT x FROM c`;

const setUp = async (options: Record<string, unknown> = {}) => {
  const records = interceptWorkers();
  const db = await createTestClient({ poolSize: 1, ...options });
  await db.run('CREATE TABLE t (a, b)');
  const worker = records[0]?.worker as unknown as PoolWorker;
  return { db, worker, records };
};

/** Every recorded execution of `sql`, oldest first (needs `debug: true`). */
const runsOf = (
  db: Awaited<ReturnType<typeof createTestClient>>,
  sql: string,
) =>
  (db.debug?.requests ?? [])
    .flatMap((r) => r.queries)
    .filter((q) => q.sql === sql);

describe('verdict', () => {
  // Falsifiable: answer 'write' for every statement in worker.ts's verdict.
  it('calls a SELECT a read', async () => {
    const { worker } = await setUp();
    expect(await worker.verdict('SELECT 1')).toBe('read');
  });

  // Falsifiable: step the statement in the verdict, and `t` holds a row.
  it('calls an INSERT a write, and runs nothing', async () => {
    const { db, worker, records } = await setUp();
    expect(await worker.verdict('INSERT INTO t VALUES (1, 1)')).toBe('write');
    expect(await db.all('SELECT * FROM t')).toEqual([]);
    expect(records[0]?.posted).toContain('verdict');
  });

  // Falsifiable: drop `explain` from kindOf's facts.
  it('calls EXPLAIN of a write a read', async () => {
    const { worker } = await setUp();
    expect(await worker.verdict('EXPLAIN INSERT INTO t VALUES (1, 1)')).toBe(
      'read',
    );
  });

  // Falsifiable: drop the authorizer's facts from kindOf.
  it('calls PRAGMA optimize a write', async () => {
    const { worker } = await setUp();
    expect(await worker.verdict('PRAGMA optimize')).toBe('write');
  });

  // Falsifiable: skip refuseMore in the verdict.
  it('refuses a string holding two statements', async () => {
    const { worker } = await setUp();
    expect(await worker.verdict('SELECT 1; SELECT 2')).toBe('refused');
  });

  // Falsifiable: answer 'write' on a failed prepare.
  it('rejects a failed prepare with STATEMENT_FAILED', async () => {
    const { worker } = await setUp();
    await expect(worker.verdict('SELECT * FROM nope')).rejects.toMatchObject({
      code: 'STATEMENT_FAILED',
      sqliteCode: 1,
    });
  });

  // Falsifiable: set allowControl in the verdict.
  it('rejects transaction control through the authorizer', async () => {
    const { worker } = await setUp();
    await expect(worker.verdict('BEGIN')).rejects.toMatchObject({
      code: 'STATEMENT_FAILED',
      sqliteCode: 23,
    });
  });

  // Falsifiable: insert in the cache whatever get_autocommit reads.
  it('answers on a worker held by a transaction, which carries on, and caches nothing there', async () => {
    const { db, worker } = await setUp({ debug: true });
    await db.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (1, 1)');
      // A miss, then a hit on the statement the transaction just ran.
      expect(await worker.verdict('SELECT 42 WHERE 0')).toBe('read');
      expect(await worker.verdict('INSERT INTO t VALUES (1, 1)')).toBe('write');
      await tx.run('INSERT INTO t VALUES (2, 2)');
    });
    expect(await db.all('SELECT a FROM t ORDER BY a')).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
    // first() asks no verdict: all() would compile the statement there. No row,
    // because first() stops at one and the reply that counts is the last.
    await db.first('SELECT 42 WHERE 0');
    expect(runsOf(db, 'SELECT 42 WHERE 0')[0]?.prepared).toBe(1);
  });

  // Falsifiable: never insert the verdict's statement in the cache.
  it('caches its statement on a free worker', async () => {
    const { db, worker } = await setUp({ debug: true });
    expect(await worker.verdict('SELECT 43')).toBe('read');
    await db.all('SELECT 43');
    expect(runsOf(db, 'SELECT 43')[0]?.prepared).toBe(0);
  });

  // Falsifiable: hold the SQLite mutex across the query's credit wait — the
  // verdict then waits for a credit only the consumer's next pull sends.
  it('answers while a stream waits for a credit, and the stream goes on', async () => {
    const { db, worker } = await setUp();
    const rows = db.stream<{ x: number }>(SERIES(1000), [], { chunkSize: 1 });
    let count = 0;
    for await (const _ of rows) {
      count++;
      if (count === 1) expect(await worker.verdict('SELECT 2')).toBe('read');
    }
    expect(count).toBe(1000);
  });

  // Falsifiable: insert the verdict's statement in the cache while a query is
  // in flight — the 32 inserts evict and finalise the stream's own statement.
  it('leaves alone the cached statement of a stream it answers beside', async () => {
    const { db, worker } = await setUp();
    const sql = SERIES(1000);
    await db.all(sql);
    const rows = db.stream<{ x: number }>(sql, [], { chunkSize: 1 });
    let count = 0;
    for await (const _ of rows) {
      count++;
      if (count === 1)
        for (let i = 0; i < 40; i++)
          expect(await worker.verdict(`SELECT ${i}`)).toBe('read');
    }
    expect(count).toBe(1000);
  });

  // Falsifiable on async/jspi: skip the mutex in the verdict — it prepares
  // while the read's step is suspended in its progress handler, where the
  // authorizer lets transaction control through and records no pragma.
  it('waits for a query stepping on the worker', async () => {
    const { db, worker } = await setUp({ debug: true });
    const sql = longQuery(2_000_000);
    let read = false;
    const reading = db.all<{ n: number }>(sql).finally(() => {
      read = true;
    });
    await waitUntil(theQueryIsRunning(db, sql), 'the long read to run');
    const verdicts = Promise.all([
      worker.verdict('PRAGMA optimize'),
      worker.verdict('SELECT a FROM t'),
    ]);
    const control = worker.verdict('BEGIN');
    control.catch(() => {});
    // Posted while the read steps, or the case is not exercised.
    expect(read).toBe(false);
    expect(await verdicts).toEqual(['write', 'read']);
    await expect(control).rejects.toMatchObject({ sqliteCode: 23 });
    expect((await reading)[0]?.n).toBe(2_000_000);
  });

  // Falsifiable: leave pending verdicts out of poison().
  it('rejects a pending verdict with the reason of terminate()', async () => {
    const { worker } = await setUp();
    const reason = new SQLiteError('WORKER_CRASHED', 'terminated by the test');
    const pending = worker.verdict('SELECT 1');
    worker.terminate(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(worker.verdict('SELECT 1')).rejects.toBe(reason);
  });

  // Falsifiable: leave pending verdicts out of poison(). The engine's kill
  // tells nothing: the death is learnt from a query's unanswered stop.
  it('rejects a verdict on a worker killed silently, once the death is learnt', async () => {
    const { db, worker } = await setUp({ drainTimeout: 500 });
    killSilently(worker);
    const pending = worker.verdict('SELECT 1');
    pending.catch(() => {});
    await expect(
      // first(): a query is posted at once, and its unanswered stop is what
      // tells of the death. all() would wait on the verdict instead.
      db.first('SELECT 1', [], { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();
    await expect(pending).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    await expect(worker.verdict('SELECT 1')).rejects.toMatchObject({
      code: 'WORKER_CRASHED',
    });
  });
});
