import { describe, expect, it } from '@rstest/core';
import { createTestClient, longQuery } from './helpers';

describe('query timeout', () => {
  it('rejects with OPERATION_TIMEOUT and leaves the client usable', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const started = performance.now();
      await expect(
        db.read(longQuery(20_000_000), [], { timeout: 200 }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
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
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
    } finally {
      await db.close();
    }
  });

  it('charges the consumer for its own slowness', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      await db.write('CREATE TABLE t (x INTEGER)');
      await db.write(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 1001) ` +
          `INSERT INTO t SELECT x FROM c`,
      );
      // The budget is wall clock from the call, so the consumer's own pauses
      // spend it. Falsifier: count the budget inside step() again and the
      // 100 ms is never reached, because MemoryVFS steps 1001 rows in
      // microseconds — the sleeping is the only thing that can exceed it.
      const iterate = async () => {
        for await (const rows of db.chunk<{ x: number }>(
          'SELECT x FROM t',
          [],
          {
            timeout: 100,
          },
        )) {
          void rows;
          await new Promise((r) => setTimeout(r, 150));
        }
      };
      await expect(iterate()).rejects.toMatchObject({
        code: 'OPERATION_TIMEOUT',
        timeout: 100,
      });
    } finally {
      await db.close();
    }
  });

  it('lets the caller signal win, with its own reason', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      const controller = new AbortController();
      const mine = new Error('mine');
      // Both are live and the caller's fires first. This pins D3 against a
      // future edit that "unifies" the two errors. Falsifier: make withDeadline
      // return its own controller's signal instead of the merged one and the
      // rejection becomes OPERATION_TIMEOUT, or never arrives at all.
      const promise = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
        timeout: 30_000,
      });
      promise.catch(() => {});
      controller.abort(mine);
      await expect(promise).rejects.toBe(mine);
    } finally {
      await db.close();
    }
  });

  it('spends the budget while the call is still queued', async () => {
    const db = await createTestClient({ vfs: 'MemoryVFS', poolSize: 1 });
    try {
      // The only worker is busy for seconds; the second call never reaches a
      // step() and must still time out. Falsifier: create the controller below
      // the lease acquisition and this goes green for the wrong reason — the
      // clock must run during the wait, which is what the assertion pins.
      const long = db.read(longQuery(20_000_000));
      long.catch(() => {});
      const started = performance.now();
      await expect(
        db.read('SELECT 1 AS one', [], { timeout: 150 }),
      ).rejects.toMatchObject({ code: 'OPERATION_TIMEOUT' });
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      await db.close();
    }
  });
});
