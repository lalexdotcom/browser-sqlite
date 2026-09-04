import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

describe('query timeout', () => {
  it('rejects with QUERY_TIMEOUT and leaves the client usable', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const started = performance.now();
      await expect(
        db.read(longQuery(20_000_000), [], { timeout: 200 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
      // The statement really stopped: nowhere near the seconds it would run.
      expect(performance.now() - started).toBeLessThan(1500);
      // And the connection still works.
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('spends the budget over the whole call, not per statement', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      // Two statements, each shorter than the budget, whose sum is not.
      const half = `${longQuery(8_000_000)};`;
      await expect(
        db.write(`${half} ${half}`, [], { timeout: 400 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  it('does not charge the consumer for its own slowness', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (1), (2), (3)');
      const seen: number[] = [];
      // The budget is 100 ms of ENGINE time; the consumer sleeps far longer
      // than that between rows and must not be timed out for it.
      for await (const row of db.stream<{ a: number }>('SELECT a FROM t', [], {
        timeout: 100,
      })) {
        await new Promise((r) => setTimeout(r, 80));
        seen.push(row.a);
      }
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      await db.close();
    }
  });
});
