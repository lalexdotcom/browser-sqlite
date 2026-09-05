import { describe, expect, it } from '@rstest/core';
import {
  aWorkerIsRunning,
  createTestClient,
  interceptWorkers,
  longQuery,
  waitUntil,
} from '../helpers';

describe('the sync build, isolated', () => {
  it('stops a running statement on abort', async () => {
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
      debug: true,
    });
    try {
      // Prime the statement cache. Without this, the first call goes through
      // sqlite.statements() which has a macrotask boundary that delivers 'stop'
      // before the step starts, making the abort land on the pre-step path
      // rather than mid-step — the slot channel never fires and the mutation
      // test gives a false GREEN. The prime ensures the abort run takes the
      // direct run(cached) path, which has no macrotask before the step.
      // Unaborted step time: ~4 343 ms (measured 2026-09-04, sync MemoryVFS).
      await db.read(longQuery(20_000_000));

      const controller = new AbortController();
      const long = db.read(longQuery(20_000_000), [], {
        signal: controller.signal,
      });
      long.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      // `started` is before the abort so the timer captures abort → drain →
      // SELECT 1. On the working path the SAB slot interrupts the step within
      // the first progress-handler call (~100 K VDBE ops); the full unaborted
      // step takes ~4 343 ms (measured). A broken interrupt channel lets the
      // step run to completion, pushing the total well past the 500 ms bound.
      const started = performance.now();
      controller.abort(new Error('cancelled'));
      await expect(long).rejects.toThrow('cancelled');
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
      const abortedCallId = records[0]?.posted.filter(
        (t) => t === 'query',
      ).length;
      expect(abortedCallId).toBeGreaterThan(0);

      // Kill the worker the abort was written for, then run past the callId
      // the slot still holds on its replacement.
      records[0]?.worker.dispatchEvent(new ErrorEvent('error'));
      // Each query needs a signal (so abortable=true, so the progress handler is
      // installed, so abortedHere() is called). The controller is never aborted;
      // its only job is to set abortable=true. The queries must also do enough
      // work to trigger the handler (PROGRESS_OPS = 100 000 VDBE instructions):
      // SELECT 1 completes in ~10 instructions and the handler never fires.
      // longQuery(200_000) crosses the threshold in < 30 ms and completes fine.
      const neverAborted = new AbortController();
      for (let i = 0; i < 8; i++) {
        expect(
          await db.read(longQuery(200_000), [], {
            signal: neverAborted.signal,
          }),
        ).toEqual([{ n: 200_000 }]);
      }
    } finally {
      await db.close();
    }
  });
});

describe('statement cache, sync build isolated', () => {
  const runsOf = (
    db: Awaited<ReturnType<typeof createTestClient>>,
    sql: string,
  ) =>
    (db.debug?.workers ?? [])
      .flatMap((w) => w.requests)
      .flatMap((r) => r.queries)
      .filter((q) => q.sql === sql);

  it('an aborted query leaves its cached statement reusable', async () => {
    // The slot delivers SQLITE_INTERRUPT without gate.isStopped() being true
    // (the sync build never yields to process the stop message). Before the
    // fix, the catch block fell through to `throw new WorkerQueryTimeout`,
    // which set failed=true, which caused settle() to evict the statement.
    // The repair adds abortedHere() to the break condition so settle() sees
    // a clean exit and keeps the statement cached.
    //
    // Falsifiability: revert `|| abortedHere()` from the SQLITE_INTERRUPT
    // catch block in worker.ts and this test fails — the third run recompiles.
    const sql = longQuery(20_000_000);
    const db = await createTestClient({
      vfs: 'MemoryVFS',
      build: 'sync',
      poolSize: 1,
      debug: true,
    });
    try {
      // Prime: compile and cache the statement (prepared=1).
      await db.read(sql);

      // Abort via the slot channel while step() is running.
      const controller = new AbortController();
      const aborting = db.read(sql, [], { signal: controller.signal });
      aborting.catch(() => {});
      await waitUntil(aWorkerIsRunning(db), 'the query to be running');
      controller.abort(new Error('cancelled'));
      await expect(aborting).rejects.toThrow('cancelled');

      // The statement must still be in the cache: prepared=0 on this run.
      await db.read(sql);
      expect(runsOf(db, sql)[2]?.prepared).toBe(0);
    } finally {
      await db.close();
    }
  });
});
