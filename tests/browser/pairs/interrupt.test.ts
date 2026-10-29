import { describe, expect, it } from 'vitest';
import {
  createTestClient,
  LONG_QUERY,
  longQuery,
  sleep,
  theQueryIsRunning,
  waitUntil,
} from '../helpers';

describe('aborting a running statement', () => {
  it('frees the worker, so the next query does not wait it out', {
    tags: ['requires:interruptible'],
  }, async () => {
    // poolSize 1: the next query MUST land on the worker that was interrupted.
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
    });
    try {
      // Prime: run the statement once so it is cached and the real abort run
      // takes run(cached) — no macrotask boundary before the step, so the step
      // always starts before 'stop' arrives. N is a parameter, so a tiny prime
      // caches the same statement the long run reuses.
      await db.all(LONG_QUERY, [1_000]);

      // N=2 G: run to its end, the step takes minutes on either engine (40 M
      // took ~8 s on Chromium async), past this test's timeout, which is the
      // bound. The abort interrupts mid-step regardless of N when the feature
      // works, so only the broken case pays for it.
      const controller = new AbortController();
      const long = db.all(LONG_QUERY, [2_000_000_000], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, LONG_QUERY),
        'the query to be running',
      );
      // On the working path the async progress handler yields via gate.tick()
      // and checks gate.isStopped(), interrupting the step at the first handler
      // call, so the read below is served at once. A broken interrupt channel
      // lets the step run to completion, and the read waits it out past the
      // test's timeout.
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      expect(await db.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
    } finally {
      await db.close();
    }
  });

  it('still rejects immediately, without waiting for the worker', {
    tags: ['requires:interruptible'],
  }, async () => {
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
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
        const prime = db.all(longQuery(20_000_000), [], {
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
      const long = db.all(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(
        theQueryIsRunning(db, longQuery(20_000_000)),
        'the query to be running',
      );
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
      // Immediate by contract: rejected before the worker has answered the
      // stop, which only a message — a later task — can report.
      expect(db.debug?.workers[0]?.status).not.toBe('READY');
    } finally {
      await db.close();
    }
  });

  it('leaves nothing broken behind', {
    tags: ['requires:interruptible'],
  }, async () => {
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
    });
    try {
      await db.run('CREATE TABLE t (a INTEGER)');
      // Fast-abort prime so the real abort run takes run(cached) and the step
      // starts. Without this the step is skipped pre-execution and the test
      // does not exercise mid-step cleanup.
      // WHAT THIS TEST PROVES: connection state is clean after an abort —
      // statements are reusable and write transactions still work. It does NOT
      // discriminate the async interrupt feature — there is no timing assertion,
      // so a broken progress handler does not cause a failure here.
      {
        const primeCtrl = new AbortController();
        const prime = db.all(longQuery(20_000_000), [], {
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
      const long = db.all(longQuery(20_000_000), [], {
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
      expect(await db.all(longQuery(1_000))).toEqual([{ n: 1_000 }]);
      await db.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (1)');
      });
      expect(await db.all('SELECT a FROM t')).toEqual([{ a: 1 }]);
    } finally {
      await db.close();
    }
  });

  // The subject is the `sync` build's degraded (non-interruptible) behaviour,
  // the opposite of `requires:interruptible`.
  // Falsifiable: run it on an `async` build, which can cut the statement
  // without isolation — the worker is then back to READY well within the 300 ms.
  it('rejects an aborted read at once, and lets its statement run on, on a sync build without isolation', {
    tags: ['build:sync', 'excludes:interruptible'],
  }, async () => {
    // The ordinary test host is NOT cross-origin isolated, so this is the
    // degraded row of the design's §6: the signal stops the wait, not the work.
    // `close()` would otherwise wait the uncuttable statement out, ~23 s on
    // Firefox, which load pushed past the test's 30 s (REUSE-LOAD).
    const db = await createTestClient({
      poolSize: 1,
      debug: true,
      drainTimeout: 2_000,
    });
    try {
      const controller = new AbortController();
      const long = db.all(longQuery(20_000_000), [], {
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
