import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  longQuery,
  sleep,
  theQueryIsRunning,
  waitUntil,
} from './helpers';

/** `longQuery` with its iteration count bound, so one cached statement serves every N. */
const LONG_QUERY =
  'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < ?) SELECT count(*) AS n FROM c';

describe('aborting a running statement', () => {
  it('frees the worker, so the next query does not wait it out', async ({
    skip,
  }) => {
    // poolSize 1: the next query MUST land on the worker that was interrupted.
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
      needs: ['interruptible'],
      skip,
    });
    try {
      // Prime: run the statement once so it is cached and the real abort run
      // takes run(cached) — no macrotask boundary before the step, so the step
      // always starts before 'stop' arrives. N is a parameter, so a tiny prime
      // caches the same statement the long run reuses.
      await db.read(LONG_QUERY, [1_000]);

      // N=40_000_000: the full step takes ~8 s on Chromium async (4x the
      // ~2 082 ms measured for 10 M on 2026-09-05 under the
      // feature-neutralising mutation), far past the bound below; Firefox runs
      // it 4-5x slower still. The abort interrupts mid-step regardless of N
      // when the feature works, so only the broken case pays for it.
      const controller = new AbortController();
      const long = db.read(LONG_QUERY, [40_000_000], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, LONG_QUERY),
        'the query to be running',
      );
      // `started` is before the abort so the timer captures abort → worker drain
      // → SELECT 1. On the working path the async progress handler yields via
      // gate.tick() and checks gate.isStopped(), interrupting the step at the
      // first handler call. A broken interrupt channel lets the step run to
      // completion, pushing the total far past the bound.
      const started = performance.now();
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      expect(await db.read('SELECT 1 AS one')).toEqual([{ one: 1 }]);
      // In isolation the short read takes ~10-20 ms on both engines; ~900 ms
      // was observed on Firefox under full-suite contention, and the bound
      // sits between that and the broken path's seconds. Anything over ~100 ms
      // in isolation means a structural problem — likely two gate.tick()
      // roundtrips instead of one — and should be investigated.
      expect(performance.now() - started).toBeLessThan(3000);
    } finally {
      await db.close();
    }
    // 90 s, against the project's 30 s default: the broken case runs the
    // 40 M step to its end, tens of seconds on Firefox, and a test that
    // exceeds its timeout does not fail, it expires mutely without naming
    // what it was waiting for.
  }, 90_000);

  it('still rejects immediately, without waiting for the worker', async ({
    skip,
  }) => {
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
      needs: ['interruptible'],
      skip,
    });
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
        await waitUntil(
          theQueryIsRunning(db, longQuery(20_000_000)),
          'prime query to start',
        );
        primeCtrl.abort();
        await expect(prime).rejects.toThrow();
      }

      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, longQuery(20_000_000)),
        'the query to be running',
      );
      const asked = performance.now();
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      // Immediate by contract; the bound leaves room for a loaded runner and
      // stays far below the seconds a rejection waiting for the worker takes.
      expect(performance.now() - asked).toBeLessThan(1000);
    } finally {
      await db.close();
    }
  });

  it('leaves nothing broken behind', async ({ skip }) => {
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
      needs: ['interruptible'],
      skip,
    });
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
        await waitUntil(
          theQueryIsRunning(db, longQuery(20_000_000)),
          'prime query to start',
        );
        primeCtrl.abort();
        await expect(prime).rejects.toThrow();
      }

      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, longQuery(20_000_000)),
        'the query to be running',
      );
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

  // One VFS: the subject is the `sync` build's degraded (non-interruptible)
  // behaviour, which needs an explicit `sync`-build pin — the opposite of
  // `needs: ['interruptible']`. OPFSAdaptiveVFS does not support `sync` at
  // all, so the pin moves to the recommended OPFSWriteAheadVFS (its default
  // build is `sync`), same precedent as isolated/abort-slot.test.ts.
  // Falsifiable: pin `build: 'async'`, which can cut the statement without
  // isolation — the worker is then back to READY well within the 300 ms.
  it('rejects an aborted read at once, and lets its statement run on, on a sync build without isolation', async () => {
    // The ordinary test host is NOT cross-origin isolated, so this is the
    // degraded row of the design's §6: the signal stops the wait, not the work.
    // `close()` would otherwise wait the uncuttable statement out, ~23 s on
    // Firefox, which load pushed past the test's 30 s (REUSE-LOAD).
    const db = await createTestClient({
      vfs: 'OPFSWriteAheadVFS',
      build: 'sync',
      poolSize: 1,
      debug: true,
      drainTimeout: 2_000,
    });
    try {
      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, longQuery(20_000_000)),
        'the query to be running',
      );
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      // The statement is not cut: the pool asked it to stop and still waits
      // for it, where the 20 M rows take seconds on either engine.
      await sleep(300);
      expect(db.debug?.workers[0]?.status).toBe('ABORTING');
    } finally {
      await db.close();
    }
  });
});
