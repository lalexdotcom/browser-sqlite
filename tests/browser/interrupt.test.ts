import { describe, expect, it } from '@rstest/core';
import {
  aWorkerIsRunning,
  createTestClient,
  longQuery,
  waitUntil,
} from './helpers';

describe('aborting a running statement', () => {
  it('frees the worker, so the next query does not wait it out', async () => {
    // poolSize 1: the next query MUST land on the worker that was interrupted.
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');

      const started = performance.now();
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      // Before this change the short read waited ~1.9 s for the abandoned
      // statement. In isolation the short read takes ~10-20 ms on both engines;
      // the 1500 ms bound exists only to survive full-suite resource contention
      // (observed: ~900 ms on Firefox when both browsers run in parallel).
      // Anything over ~100 ms in isolation means a structural problem — likely
      // two gate.tick() roundtrips instead of one — and should be investigated,
      // not papered over by widening this bound further.
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      await db.close();
    }
  });

  it('still rejects immediately, without waiting for the worker', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      const asked = performance.now();
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      expect(performance.now() - asked).toBeLessThan(200);
    } finally {
      await db.close();
    }
  });

  it('leaves nothing broken behind', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    try {
      await db.write('CREATE TABLE t (a INTEGER)');
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      // The same SQL runs again: the statement the abort left behind is
      // reusable, not poisoned, and it holds no read transaction open.
      expect(await db.read(longQuery(1_000))).toEqual([{ n: 1_000 }]);
      await db.transaction(async (tx) => {
        await tx.write('INSERT INTO t VALUES (1)');
      });
      expect(await db.read('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('leaves a sync build degraded, and says so by behaving so', async () => {
    // The ordinary test host is NOT cross-origin isolated, so this is the
    // degraded row of the design's §6: the signal stops the wait, not the work.
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
      debug: true,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      // A timeout DOES interrupt the same build — the asymmetry the design
      // turns on.
      await expect(
        db.read(longQuery(20_000_000), [], { timeout: 200 }),
      ).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
    } finally {
      await db.close();
    }
  });
});
