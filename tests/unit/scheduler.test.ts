import { describe, expect, it } from '@rstest/core';
import { createScheduler } from '../../src/scheduler';

type TestWorker = { index: number };

const makeScheduler = (size = 2, onIdle?: (w: TestWorker) => void) => {
  const scheduler = createScheduler<TestWorker>(onIdle ? { onIdle } : {});
  const workers = Array.from({ length: size }, (_, index) => ({ index }));
  for (const worker of workers) scheduler.add(worker);
  return { scheduler, workers };
};

/** Drains the microtask queue regardless of how many hops a resolution takes. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('scheduler — acquisition', () => {
  it('hands out the lowest-index available worker', async () => {
    const { scheduler } = makeScheduler(3);
    const a = await scheduler.acquire('read');
    const b = await scheduler.acquire('read');
    expect(a.worker.index).toBe(0);
    expect(b.worker.index).toBe(1);
  });

  it('does not hand the same worker to two holders', async () => {
    const { scheduler } = makeScheduler(1);
    const first = await scheduler.acquire('read');
    let secondIndex: number | undefined;
    void scheduler.acquire('read').then((lease) => {
      secondIndex = lease.worker.index;
    });
    await flush();
    expect(secondIndex).toBeUndefined();
    first.release();
    await flush();
    expect(secondIndex).toBe(0);
  });

  it('serves queued requests in FIFO order', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const order: string[] = [];
    const one = scheduler.acquire('read').then((l) => {
      order.push('one');
      l.release();
    });
    const two = scheduler.acquire('read').then((l) => {
      order.push('two');
      l.release();
    });
    held.release();
    await one;
    await two;
    expect(order).toEqual(['one', 'two']);
  });

  it('serves a waiting writer before a waiting reader', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('write');
    const order: string[] = [];
    const reader = scheduler.acquire('read').then((l) => {
      order.push('read');
      l.release();
    });
    const writer = scheduler.acquire('write').then((l) => {
      order.push('write');
      l.release();
    });
    held.release();
    await writer;
    await reader;
    expect(order).toEqual(['write', 'read']);
  });
});

describe('scheduler — writer designation', () => {
  it('routes every write to the same worker once one is designated', async () => {
    // With 2 workers, designate worker 0 as writer then release it.
    // A reader immediately acquires worker 0 (lowest-index-first), leaving only
    // worker 1 available. A subsequent write must queue (the designated writer is
    // busy) rather than being handed worker 1.
    const { scheduler } = makeScheduler(2);
    const a = await scheduler.acquire('write'); // worker 0, designated
    a.release();
    const reader = await scheduler.acquire('read'); // takes worker 0 (lowest-index)

    let writeIndex: number | undefined;
    const pending = scheduler.acquire('write').then((l) => {
      writeIndex = l.worker.index;
      l.release();
    });
    // Correct: write queues because designated worker 0 is busy.
    // Broken (no designation): write grabs worker 1 immediately.
    await flush();
    expect(writeIndex).toBeUndefined();

    reader.release(); // hands worker 0 to the queued write
    await pending;
    expect(writeIndex).toBe(0);
  });

  it('designates the writer when a queued writer is served', async () => {
    // Regression: the original releaseWorker handed the worker to a queued
    // writer without setting currentWriterIndex when it was -1, so the next
    // write acquisition could designate a SECOND writer.
    //
    // Both workers must be busy for the write to actually queue, and worker 1
    // must be the one released — otherwise the buggy path (designation left at
    // -1, lowest-index-first) and the correct path both pick worker 0 and the
    // test proves nothing.
    const { scheduler } = makeScheduler(2);
    const readerA = await scheduler.acquire('read'); // worker 0
    const readerB = await scheduler.acquire('read'); // worker 1
    const queued = scheduler.acquire('write');

    readerB.release();
    const served = await queued;
    expect(served.worker.index).toBe(1);

    readerA.release();
    served.release();

    const next = await scheduler.acquire('write');
    // Correct: designation is 1, so the write goes back to worker 1.
    // Buggy: designation is still -1, so lowest-index-first picks worker 0.
    expect(next.worker.index).toBe(1);
  });

  it('clears the designation when the writer goes to a reader', async () => {
    // A reader must genuinely queue, so every worker has to be busy first.
    const { scheduler } = makeScheduler(2);
    const writer = await scheduler.acquire('write'); // worker 0, designated
    const reader = await scheduler.acquire('read'); // worker 1
    const queuedReader = scheduler.acquire('read');

    writer.release(); // hands worker 0 to the queued reader, clearing designation
    const servedReader = await queuedReader;
    expect(servedReader.worker.index).toBe(0);

    // With the designation cleared, a queued write claims whichever worker frees
    // up next — here worker 1, not the former writer.
    const queuedWrite = scheduler.acquire('write');
    reader.release();
    const newWriter = await queuedWrite;
    expect(newWriter.worker.index).toBe(1);
  });
});

describe('scheduler — removal', () => {
  // Falsifiable: delete the `generations.set(...)` line in remove() — the stale
  // release() then sees a matching generation and calls handOver, handing the
  // corpse to the queued acquire and making served true.
  it('does not hand back a removed worker when its lease is released late', async () => {
    const { scheduler } = makeScheduler(1);
    const lease = await scheduler.acquire('read');
    scheduler.remove(0);
    let served = false;
    void scheduler.acquire('read').then(() => {
      served = true;
    });
    lease.release();
    await flush();
    expect(served).toBe(false);
  });

  // Falsifiable: delete the `currentWriterIndex = -1` line in remove().
  it('frees the writer designation when the writer is removed', async () => {
    const { scheduler } = makeScheduler(2);
    const writer = await scheduler.acquire('write');
    expect(writer.worker.index).toBe(0);
    writer.release();
    scheduler.remove(0);
    const next = await scheduler.acquire('write');
    expect(next.worker.index).toBe(1);
  });

  it('revives an index when a replacement is added', async () => {
    const { scheduler } = makeScheduler(1);
    scheduler.remove(0);
    scheduler.add({ index: 0 });
    const lease = await scheduler.acquire('read');
    expect(lease.worker.index).toBe(0);
  });

  // Falsifiable: delete the `generations.set(...)` line in remove() — the
  // old lease then matches the revived generation and handOver fires while the
  // new lease is still live, putting index 0 back in the pool prematurely.
  it('a release from before remove() is a no-op after the slot is revived', async () => {
    const { scheduler } = makeScheduler(1);
    const leaseA = await scheduler.acquire('read');
    scheduler.remove(0);
    scheduler.add({ index: 0 });
    const leaseB = await scheduler.acquire('read');
    leaseA.release(); // stale — must be a no-op
    await flush();
    // index 0 must still be exclusively held by leaseB, not back in the pool.
    let served = false;
    void scheduler.acquire('read').then(() => {
      served = true;
    });
    await flush();
    expect(served).toBe(false);
    leaseB.release();
    await flush();
    expect(served).toBe(true);
  });
});

describe('scheduler — shutdown', () => {
  // Falsifiable: delete the reject loop over the queues in shutdown().
  it('rejects queued waiters with the given reason', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const queued = scheduler.acquire('read');
    const reason = new Error('closing');
    void scheduler.shutdown(reason);
    await expect(queued).rejects.toBe(reason);
    held.release();
  });

  // Falsifiable: delete the `if (shutdownReason) throw shutdownReason` guard in acquire().
  it('rejects every later acquisition', async () => {
    const { scheduler } = makeScheduler(1);
    const reason = new Error('closing');
    void scheduler.shutdown(reason);
    await expect(scheduler.acquire('read')).rejects.toBe(reason);
  });

  // Falsifiable: resolve the shutdown promise immediately instead of waiting on
  // `leased.size === 0` and this fails.
  it('settles only when the last outstanding lease comes back', async () => {
    const { scheduler } = makeScheduler(2);
    const a = await scheduler.acquire('read');
    const b = await scheduler.acquire('read');
    let settled = false;
    void scheduler.shutdown(new Error('closing')).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    a.release();
    await flush();
    expect(settled).toBe(false);
    b.release();
    await flush();
    expect(settled).toBe(true);
  });

  // Falsifiable: drop the `leased.delete(index)` line from remove() — the
  // shutdown promise then waits forever on a lease nobody can return.
  it('does not wait on a lease whose worker was removed', async () => {
    const { scheduler } = makeScheduler(1);
    await scheduler.acquire('read');
    let settled = false;
    void scheduler.shutdown(new Error('closing')).then(() => {
      settled = true;
    });
    scheduler.remove(0);
    await flush();
    expect(settled).toBe(true);
  });
});

describe('scheduler — leases', () => {
  it('keeps a worker across many statements while others wait (B1)', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('write');
    let intruder: number | undefined;
    void scheduler.acquire('read').then((l) => {
      intruder = l.worker.index;
    });
    for (let statement = 0; statement < 5; statement++) {
      await flush();
      expect(intruder).toBeUndefined();
    }
    held.release();
    await flush();
    expect(intruder).toBe(0);
  });

  it('ignores a second release', async () => {
    // Both double-release calls happen while two waiters are queued. Without the
    // idempotency guard the second handOver invocation would serve the second
    // waiter immediately, giving two holders the same worker.
    const { scheduler } = makeScheduler(1);
    const lease = await scheduler.acquire('read');
    let firstServed = false;
    let secondServed = false;
    void scheduler.acquire('read').then(() => {
      firstServed = true;
    });
    void scheduler.acquire('read').then(() => {
      secondServed = true;
    });
    lease.release();
    lease.release(); // must be a no-op
    await flush();
    expect(firstServed).toBe(true); // the first waiter was served
    expect(secondServed).toBe(false); // the second must not be — same worker cannot have two holders
  });

  it('calls onIdle only when no request is waiting', async () => {
    const idle: number[] = [];
    const { scheduler } = makeScheduler(1, (w) => idle.push(w.index));
    const held = await scheduler.acquire('read');
    const queued = scheduler.acquire('read');
    held.release();
    const served = await queued;
    expect(idle).toEqual([]);
    served.release();
    expect(idle).toEqual([0]);
  });
});

describe('scheduler — add() drains pre-queued acquires', () => {
  /**
   * Covers the path in add() where writerQueue/readerQueue already has entries
   * when the worker is registered. The makeScheduler helper adds workers before
   * any acquire(), so this path is invisible to the rest of the suite.
   * A regression here would exactly replay how B1 survived: a correctness
   * invariant exercised only by slow browser tests.
   *
   * Failure conditions are documented inline.
   */

  it('serves a queued read when the first worker is added', async () => {
    // No makeScheduler — workers must arrive AFTER acquire() to exercise the drain.
    const scheduler = createScheduler<TestWorker>();
    const worker = { index: 0 };

    let resolvedIndex: number | undefined;
    void scheduler.acquire('read').then((l) => {
      resolvedIndex = l.worker.index;
    });

    await flush();
    // If add() does not drain the queue the acquire() Promise never resolves
    // and resolvedIndex stays undefined.
    expect(resolvedIndex).toBeUndefined();

    scheduler.add(worker);
    await flush();

    // Fails if add() still only calls available.add() without draining
    // readerQueue — the Promise would remain pending.
    expect(resolvedIndex).toBe(0);
  });

  it('serves a queued write and designates the worker when it is added', async () => {
    const scheduler = createScheduler<TestWorker>();
    const worker = { index: 0 };

    let firstWriteIndex: number | undefined;
    const firstWrite = scheduler.acquire('write').then((l) => {
      firstWriteIndex = l.worker.index;
      l.release();
    });

    await flush();
    expect(firstWriteIndex).toBeUndefined();

    scheduler.add(worker);
    await firstWrite;

    // Fails if add() does not drain writerQueue — firstWrite would hang.
    expect(firstWriteIndex).toBe(0);

    // After that write released, a new write must still go to the designated
    // worker (index 0). Fails if add() bypassed the designation logic in
    // handOver (e.g. skipped the currentWriterIndex = worker.index assignment).
    const secondWrite = await scheduler.acquire('write');
    expect(secondWrite.worker.index).toBe(0);
  });
});

describe('scheduler — add() writer-designation with multiple queued writes', () => {
  /**
   * Regression: without `currentWriterIndex = worker.index` inside add(),
   * adding a second worker while two writes are queued results in two concurrent
   * writers.  The sequence:
   *
   *   add(worker 0) — serves write 1, but leaves currentWriterIndex at -1
   *   add(worker 1) — sees currentWriterIndex === -1 → condition passes → serves
   *                   write 2 on worker 1, creating a second simultaneous writer.
   *
   * With the fix, add(worker 0) sets currentWriterIndex = 0 first, so add(worker 1)
   * sees currentWriterIndex === 0 ≠ 1 → condition fails → worker 1 goes to
   * available, and write 2 must wait until worker 0 is released.
   */
  it('second queued write waits for the first lease when two workers are added', async () => {
    const scheduler = createScheduler<TestWorker>();

    let firstLease: { worker: TestWorker; release: () => void } | undefined;
    let secondWriteIndex: number | undefined;

    // Queue two writes before any worker exists.
    const firstAcquire = scheduler.acquire('write').then((l) => {
      firstLease = l;
      // Deliberately keep the lease held to detect concurrent writers.
    });

    void scheduler.acquire('write').then((l) => {
      secondWriteIndex = l.worker.index;
      l.release();
    });

    await flush();
    // Nothing served yet — no workers.
    expect(firstLease).toBeUndefined();
    expect(secondWriteIndex).toBeUndefined();

    // Add both workers synchronously.
    scheduler.add({ index: 0 });
    scheduler.add({ index: 1 });

    await flush();

    // First write must be served (on worker 0, which add() designated).
    expect(firstLease?.worker.index).toBe(0);

    // Second write must NOT yet be served — it must wait for the first lease.
    // Without the fix: add(worker 1) would serve it immediately on worker 1,
    // and secondWriteIndex would be 1 here instead of undefined.
    expect(secondWriteIndex).toBeUndefined();

    // Releasing the first lease hands worker 0 to the queued second write.
    firstLease!.release();
    await flush();

    // Second write must run on worker 0 (the designated writer), not worker 1.
    expect(secondWriteIndex).toBe(0);

    await firstAcquire; // settle the promise chain
  });
});
