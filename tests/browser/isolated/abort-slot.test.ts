import { describe, expect, it } from '@rstest/core';
import { createTestClient, interceptWorkers, longQuery } from '../helpers';

describe('the sync build, isolated', () => {
  it('stops a running statement on abort', async () => {
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');

      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      expect(performance.now() - started).toBeLessThan(500);
    } finally {
      await db.close();
    }
  });

  it("does not carry a dead worker's abort into its replacement", async () => {
    // The slot holds a callId, and a restarted worker's callIds start at 0
    // again — so the slot must be zeroed when a worker is created into it.
    // Without that zeroing this test fails on the query whose callId matches
    // the one the abort wrote, and on no other: the defect is a single wrong
    // interrupt, several queries after the restart.
    const records = interceptWorkers();
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
      maxWorkerRestarts: 1,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      setTimeout(() => controller.abort(new Error('cancelled')), 100);
      await expect(long).rejects.toThrow('cancelled');
      const abortedCallId = records[0]?.posted.filter(
        (t) => t === 'query',
      ).length;
      expect(abortedCallId).toBeGreaterThan(0);

      // Kill the worker the abort was written for, then run past the callId
      // the slot still holds on its replacement.
      records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
      for (let i = 0; i < 8; i++) {
        expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      }
    } finally {
      await db.close();
    }
  });
});
