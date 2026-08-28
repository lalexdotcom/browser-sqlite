import { describe, expect, it } from '@rstest/core';
import {
  createTestClient,
  interceptWorkers,
  longQuery,
  sleep,
} from './helpers';

describe('a long single step', () => {
  // Falsifiable: bound the query itself with any timer and this fails.
  it('runs to completion untouched', async () => {
    const db = await createTestClient({ poolSize: 1 });
    const rows = await db.read<{ n: number }>(longQuery(2_000_000));
    expect(rows[0]?.n).toBe(2_000_000);
  });

  // Falsifiable: drop the abort from the race in chunk() and go back to testing
  // `aborted` after the await — the rejection then waits for the sort to finish
  // and this exceeds its budget.
  it('gives the caller back control at the moment the signal fires', async () => {
    const db = await createTestClient({ poolSize: 2 });
    const started = performance.now();
    await expect(
      db.read(longQuery(20_000_000), [], {
        signal: AbortSignal.timeout(200),
      }),
    ).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(3000);
  });

  // Falsifiable: set poolSize to 1 — the read then has nowhere to go while the
  // abandoned worker drains, sits in the reader queue, and `queue.read` is 1.
  //
  // The assertion is on the POOL, never on the second read's latency, and the
  // difference is not pedantry: timing that read end to end measures the FILE.
  // A read served by a worker that has not seen the last commit runs the commit
  // barrier first, and the barrier reads `sqlite_master`. On an engine without
  // `readwrite-unsafe` that barrier waits for the abandoned worker's step() to
  // end — README, "Reduced mode" — so the read takes ~30 s on Firefox with a
  // free worker and an empty queue. This test used to time the read and failed
  // on Firefox naming the pool for a fact about OPFS handles (1 run in 3 until
  // last-writer routing made it every run; diagnosed 2026-08-28).
  //
  // Not falsifiable here, deliberately: awaiting the quiesce promise in
  // client.ts's finally instead of chaining the release on it holds the CALLER,
  // not the pool — the lease returns on quiesce either way — so it never moves
  // `queue.read`. It goes red one `it()` above, which is where that belongs.
  it('does not terminate the worker it abandoned, and does not block the pool', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({
      poolSize: 2,
      drainTimeout: 60_000,
      debug: true,
    });
    await db.write('CREATE TABLE t (a)');

    await expect(
      db.read(longQuery(20_000_000), [], { signal: AbortSignal.timeout(200) }),
    ).rejects.toThrow();

    // Not awaited: on a reduced-mode VFS this read outlives the test, held by
    // the barrier above. The catch is what keeps that from surfacing as an
    // unhandled rejection when the client is torn down.
    const pending = db.read<{ n: number }>('SELECT 1 AS n');
    pending.catch(() => {});
    await sleep(500);

    // Non-vacuity: the abandoned worker is still inside its step, so the pool
    // really is down to one worker at the moment the queue is read. Without
    // this the assertion below would also pass on a pool with nothing to do.
    expect(
      db.debug?.workers.some((worker) => worker.status === 'ABORTING'),
    ).toBe(true);
    // The read was handed a worker at once — not queued behind a busy one
    // (`read`), and not waiting for the pool to exist either (`gated`).
    // Asserting only `read` would also pass on a caller suspended on the
    // readiness gate, which sits in neither wait queue.
    expect(db.debug?.queue.read).toBe(0);
    expect(db.debug?.queue.gated).toBe(0);

    expect(records.some((record) => record.terminated)).toBe(false);
    expect(records.length).toBe(2);
  });
});

describe('a worker killed silently', () => {
  // The drain bound from Task 6, provable only now: without the prompt abort
  // the caller never reaches the drain at all.
  // Falsifiable: remove the timer from the drain race in pool.ts — the slot is
  // then never reclaimed and the last two assertions fail.
  it('is presumed dead when it never answers the stop request', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, drainTimeout: 500 });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000), [], {
      signal: AbortSignal.timeout(200),
    });
    await sleep(100);
    records[0].worker.terminate(); // silent death: no event of any kind

    await expect(running).rejects.toThrow();
    await sleep(2000); // drainTimeout, then the replacement's boot
    const rows = await db.read<{ n: number }>('SELECT 1 AS n');
    expect(rows[0]?.n).toBe(1);
    expect(records.length).toBe(2);
  });
});
