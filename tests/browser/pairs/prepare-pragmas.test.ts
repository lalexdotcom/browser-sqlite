import { describe, expect, it } from 'vitest';
import type { PoolWorker } from '../../../src/pool';
import { createTestClient, interceptWorkers } from '../helpers';

/**
 * Some pragmas act at prepare: `PRAGMA cache_size = 5`, prepared and never
 * stepped, sets 5. A statement that must not write is therefore prepared with
 * them answered SQLITE_IGNORE by the worker's authorizer.
 */

type Db = Awaited<ReturnType<typeof createTestClient>>;

const cacheSize = async (db: Db) =>
  (await db.first<{ cache_size: number }>('PRAGMA cache_size'))?.cache_size;

describe('a pragma that acts at prepare', () => {
  // Falsifiable: return SQLITE_OK for every pragma in the worker's authorize.
  it('is not applied by a first() that refuses it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const before = await cacheSize(db);
    expect(before).not.toBe(5);
    await expect(db.first('PRAGMA cache_size = 5')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    expect(await cacheSize(db)).toBe(before);
  });

  // Falsifiable: as above.
  it('is not applied by the verdict of the worker that answers', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1 });
    const before = await cacheSize(db);
    const worker = records[0]?.worker as unknown as PoolWorker;
    expect(await worker.verdict('PRAGMA cache_size = 5')).toBe('write');
    expect(await cacheSize(db)).toBe(before);
  });

  // Falsifiable: cache an ignored handle, in verdictOf or in the query's
  // single-statement branch (src/worker/worker.ts) — the writer then runs its
  // empty program.
  it('is applied by run(), on the writer, after a verdict that ignored it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    await expect(db.first('PRAGMA cache_size = 5')).rejects.toMatchObject({
      code: 'NOT_A_READ_QUERY',
    });
    await db.run('PRAGMA cache_size = 5');
    expect(await cacheSize(db)).toBe(5);
  });

  // A route that asks no verdict and refuses nothing. Falsifiable: drop the
  // EXPLAIN_FIRST test from the worker's authorize.
  it('is not applied under EXPLAIN, which runs nothing', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const before = await cacheSize(db);
    await db.transaction(async (tx) => {
      await tx.all('EXPLAIN PRAGMA cache_size = 7');
      expect(
        (await tx.first<{ cache_size: number }>('PRAGMA cache_size'))
          ?.cache_size,
      ).toBe(before);
    });
  });

  // Falsifiable: leave `compiling.guarded` false for a statement carrying
  // refuseWrite in the worker's query.
  it('is not applied by a read-only transaction that refuses it', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const queryOnly = await db.transaction(
      async (tx) => {
        await expect(tx.run('PRAGMA query_only = 1')).rejects.toMatchObject({
          code: 'READ_ONLY_TRANSACTION',
        });
        return (await tx.first<{ query_only: number }>('PRAGMA query_only'))
          ?.query_only;
      },
      { readOnly: true },
    );
    expect(queryOnly).toBe(0);
  });
});
