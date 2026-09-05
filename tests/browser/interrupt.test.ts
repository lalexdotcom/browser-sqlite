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
      // Slow prime: run the query to completion so the statement is cached and
      // the real abort run takes run(cached) — no macrotask boundary before
      // the step, so the step always starts before 'stop' arrives.
      // N=10_000_000 chosen so that: (a) the full step takes ~2 082 ms on
      // Chromium (measured 2026-09-05 under the feature-neutralising mutation),
      // well above the 1 500 ms bound; (b) the prime completes in ~15 s on
      // Firefox, within the 30 s test timeout. The abort interrupts mid-step
      // quickly regardless of N when the feature works.
      await db.read(longQuery(10_000_000));

      const controller = new AbortController();
      const long = db.read(longQuery(10_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      // `started` is before the abort so the timer captures abort → worker drain
      // → SELECT 1. On the working path the async progress handler yields via
      // gate.tick() and checks gate.isStopped(), interrupting the step at the
      // first handler call; the full unaborted step takes ~2 082 ms on Chromium
      // async (measured 2026-09-05 under the feature-neutralising mutation). A
      // broken interrupt channel lets the step run to completion, pushing the
      // total well past the 1 500 ms bound.
      const started = performance.now();
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
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
      // Fast-abort prime (same rationale as "frees the worker" above):
      // ensure the real abort run takes run(cached) so the step starts.
      // WHAT THIS TEST PROVES: client-side promise rejection fires before the
      // worker drains. It does NOT discriminate the async interrupt feature —
      // the pool resolves the promise on abort regardless of whether the
      // progress handler is installed, so removing the handler leaves the
      // 200 ms assertion unchanged. Use "frees the worker" to pin that feature.
      {
        const primeCtrl = new AbortController();
        const prime = db.read(longQuery(20_000_000), [], {
          signal: primeCtrl.signal,
        });
        prime.catch(() => {});
        await waitUntil(aWorkerIsRunning(db), 'prime query to start');
        primeCtrl.abort();
        await expect(prime).rejects.toThrow();
      }

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
      // Fast-abort prime so the real abort run takes run(cached) and the step
      // starts. Without this the step is skipped pre-execution and the test
      // does not exercise mid-step cleanup.
      // WHAT THIS TEST PROVES: connection state is clean after an abort —
      // statements are reusable and write transactions still work. It does NOT
      // discriminate the async interrupt feature — there is no timing assertion,
      // so a broken progress handler does not cause a failure here.
      {
        const primeCtrl = new AbortController();
        const prime = db.read(longQuery(20_000_000), [], {
          signal: primeCtrl.signal,
        });
        prime.catch(() => {});
        await waitUntil(aWorkerIsRunning(db), 'prime query to start');
        primeCtrl.abort();
        await expect(prime).rejects.toThrow();
      }

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
