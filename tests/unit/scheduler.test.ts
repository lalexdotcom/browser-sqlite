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
  it('routes concurrent writes to the same designated worker', async () => {
    // Worker 0 takes a write (designated). While it is still in flight, a
    // second write is queued. The second must wait for worker 0, not grab
    // worker 1.
    // Falsified by removing the designation check in takeAvailable: the second
    // write finds worker 1 available immediately and secondIndex is set before
    // the flush.
    const { scheduler } = makeScheduler(2);
    const first = await scheduler.acquire('write'); // worker 0, designated

    let secondIndex: number | undefined;
    const pending = scheduler.acquire('write').then((l) => {
      secondIndex = l.worker.index;
      l.release();
    });
    // Correct: write queues because designated worker 0 is busy.
    // Broken (no designation): write grabs worker 1 immediately.
    await flush();
    expect(secondIndex).toBeUndefined();

    first.release(); // hands worker 0 to the queued write
    await pending;
    expect(secondIndex).toBe(0);
  });

  it('designates the writer when a queued write is served via handOver', async () => {
    // Regression: the original releaseWorker handed the worker to a queued
    // writer without setting currentWriterIndex when it was -1, so a concurrent
    // write acquisition could designate a SECOND writer.
    //
    // Both workers must be busy for the write to actually queue, and worker 1
    // must be the one released — otherwise the correct and buggy paths both
    // pick worker 0 and the test proves nothing.
    const { scheduler } = makeScheduler(2);
    const readerA = await scheduler.acquire('read'); // worker 0
    const readerB = await scheduler.acquire('read'); // worker 1
    const firstWrite = scheduler.acquire('write'); // queues (both busy)

    readerB.release(); // handOver → serves queued write on worker 1; designates 1
    const served = await firstWrite;
    expect(served.worker.index).toBe(1);

    // Queue a second write while served is still in flight on worker 1.
    // It must wait for worker 1 (the designated writer), not grab worker 0
    // when readerA is released.
    // Falsified by removing `currentWriterIndex = worker.index` in handOver's
    // write branch: designation stays -1 and the write grabs worker 0 instead.
    let secondIndex: number | undefined;
    const secondWrite = scheduler.acquire('write').then((l) => {
      secondIndex = l.worker.index;
      l.release();
    });

    readerA.release(); // worker 0 goes to available; second write must still queue
    await flush();
    expect(secondIndex).toBeUndefined(); // waiting for designated worker 1

    served.release(); // hands worker 1 to the second queued write
    await secondWrite;
    expect(secondIndex).toBe(1);
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

describe('scheduler — read neutrality', () => {
  it('releasing a read lease does not alter the writer designation', async () => {
    // Designate worker 1 as writer (write in flight). Worker 0 serves a read
    // concurrently. When the read on worker 0 finishes, the designation must
    // still point at worker 1 — a subsequent write must queue for worker 1,
    // not grab worker 0 immediately.
    // Falsified by adding `currentWriterIndex = -1` to the read-lease release
    // path: takeAvailable(true) falls through to lowest-index-first and returns
    // worker 0, so newWriteIndex is defined before the flush.
    const scheduler = createScheduler<TestWorker>();
    const writePending = scheduler.acquire('write');
    scheduler.add({ index: 1 }); // gets queued write; designated writer (1)
    scheduler.add({ index: 0 }); // goes to available
    const writeLease = await writePending;
    expect(writeLease.worker.index).toBe(1);

    // Worker 0 takes a read while worker 1 is still writing.
    const readLease = await scheduler.acquire('read');
    expect(readLease.worker.index).toBe(0); // lowest-index-first

    // Release the read — must NOT touch the designation.
    readLease.release();
    await flush();

    // A new write must queue for the designated writer (1), not grab worker 0.
    let newWriteIndex: number | undefined;
    const newWrite = scheduler.acquire('write').then((l) => {
      newWriteIndex = l.worker.index;
      l.release();
    });
    await flush();
    expect(newWriteIndex).toBeUndefined(); // still waiting for worker 1

    writeLease.release();
    await newWrite;
    expect(newWriteIndex).toBe(1);
  });

  it('two writes never run concurrently', async () => {
    // While a write is in flight, a second acquire must queue rather than
    // landing on another available worker.
    // Falsified by removing designation tracking: takeAvailable() falls through
    // to lowest-index-first and returns worker 1 immediately, so secondStarted
    // is true after the flush.
    const { scheduler } = makeScheduler(2);
    const firstWrite = await scheduler.acquire('write'); // worker 0, designated

    let secondStarted = false;
    const secondWrite = scheduler.acquire('write').then((l) => {
      secondStarted = true;
      l.release();
    });

    await flush();
    expect(secondStarted).toBe(false); // queued, not running

    firstWrite.release();
    await secondWrite;
    expect(secondStarted).toBe(true);
  });

  it('releases the designation when the writer hands over to a queued read', async () => {
    // The reader exit of handOver is a separate path from the idle exit, and it
    // must release the designation too. Both workers busy: worker 1 writes
    // (designated), worker 0 reads, a third read is queued. The write finishes
    // and its worker goes straight to the queued read, never passing through
    // `available` — so this exit is the one under test.
    // Falsifiable: move the `currentWriterIndex = -1` line in handOver() below
    // the readerQueue branch. This exit then keeps the designation on the busy
    // worker 1 and the closing write stays queued — newWriteIndex is undefined.
    const scheduler = createScheduler<TestWorker>();
    const writePending = scheduler.acquire('write');
    scheduler.add({ index: 1 }); // gets queued write; designated writer (1)
    scheduler.add({ index: 0 }); // goes to available
    const writeLease = await writePending;
    expect(writeLease.worker.index).toBe(1);

    // Worker 0 takes a read — both workers are now busy.
    const reader0 = await scheduler.acquire('read');
    expect(reader0.worker.index).toBe(0);

    // Queue a read. Both workers busy, so it waits.
    const queuedRead = scheduler.acquire('read');

    // Write finishes on worker 1; handOver routes the queued read to worker 1,
    // which therefore stays busy for the rest of the test.
    writeLease.release();
    const servedRead = await queuedRead;
    expect(servedRead.worker.index).toBe(1);

    reader0.release(); // worker 0 is the only free worker
    await flush();

    let newWriteIndex: number | undefined;
    void scheduler.acquire('write').then((lease) => {
      newWriteIndex = lease.worker.index;
    });
    await flush();

    expect(newWriteIndex).toBe(0);
    servedRead.release();
  });
});
describe('scheduler — stats()', () => {
  it('reports queue depths and lease counts', async () => {
    const scheduler = createScheduler<{ index: number }>();
    scheduler.add({ index: 0 });

    expect(scheduler.stats()).toMatchObject({
      available: 1,
      leased: 0,
      read: 0,
      write: 0,
    });

    const lease = await scheduler.acquire('read');
    expect(scheduler.stats()).toMatchObject({ available: 0, leased: 1 });

    // Nothing free: this one queues.
    void scheduler.acquire('read');
    expect(scheduler.stats().read).toBe(1);

    lease.release();
  });
});

describe('scheduler — writer policy', () => {
  const makeBiased = (size = 2) => {
    const scheduler = createScheduler<TestWorker>({
      canDesignateWriter: (index) => index !== 0,
    });
    const workers = Array.from({ length: size }, (_, index) => ({ index }));
    for (const worker of workers) scheduler.add(worker);
    return { scheduler, workers };
  };

  it('designates the lowest index the policy accepts', async () => {
    const { scheduler } = makeBiased(3);
    const lease = await scheduler.acquire('write');
    expect(lease.worker.index).toBe(1);
  });

  it('leaves reads untouched by the policy', async () => {
    const { scheduler } = makeBiased(2);
    const lease = await scheduler.acquire('read');
    expect(lease.worker.index).toBe(0);
  });

  it('does not designate a refused worker that joins with a write queued', async () => {
    const scheduler = createScheduler<TestWorker>({
      canDesignateWriter: (index) => index !== 0,
    });
    const pending = scheduler.acquire('write');
    scheduler.add({ index: 0 });
    await flush();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    scheduler.add({ index: 1 });
    const lease = await pending;
    expect(lease.worker.index).toBe(1);
  });

  it('does not designate a refused worker that is handed back', async () => {
    const { scheduler } = makeBiased(2);
    // Lease both workers so nothing is free.
    const r0 = await scheduler.acquire('read'); // takes w0
    const r1 = await scheduler.acquire('read'); // takes w1

    // Queue a write — nothing is free, so it stays pending.
    const pending = scheduler.acquire('write');
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    // Return w0 — policy refuses it as a writer, so the queued write must stay pending.
    r0.release();
    await flush();
    expect(settled).toBe(false);

    // Return w1 — policy accepts it, so the queued write is served by w1.
    r1.release();
    const lease = await pending;
    expect(lease.worker.index).toBe(1);
  });

  it('accepts every index by default — production behaviour is unchanged', async () => {
    const { scheduler } = makeScheduler(2);
    const lease = await scheduler.acquire('write');
    expect(lease.worker.index).toBe(0);
  });
});

describe('scheduler — writer designation release', () => {
  it('releases the designation when the writer is released with no write queued', async () => {
    // Falsifiable: delete the `if (currentWriterIndex === worker.index)
    // currentWriterIndex = -1;` line in handOver() and the second write queues
    // behind worker 0 forever — newWriteIndex stays undefined.
    const { scheduler } = makeScheduler(2);

    const write = await scheduler.acquire('write');
    expect(write.worker.index).toBe(0);
    write.release(); // nothing queued behind it: the designation must not survive
    await flush();

    // A read now occupies worker 0 — the worker the stale designation pinned.
    const read = await scheduler.acquire('read');
    expect(read.worker.index).toBe(0);

    let newWriteIndex: number | undefined;
    void scheduler.acquire('write').then((lease) => {
      newWriteIndex = lease.worker.index;
    });
    await flush();

    // Sticky: queues for the busy worker 0 and stays undefined.
    // Released: takes the first free worker.
    expect(newWriteIndex).toBe(1);
    read.release();
  });
});

describe('scheduler — onFirstSettle callback', () => {
  // Falsifiable: never call onFirstSettle — the callback is never invoked and
  // result stays undefined.
  it('fires once when all poolSize slots have settled', () => {
    let result: { openedCount: number; failedIndices: number[] } | undefined;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 3,
      onFirstSettle: (r) => {
        result = r;
      },
    });

    scheduler.add({ index: 0 });
    scheduler.add({ index: 1 });
    expect(result).toBeUndefined(); // not yet — slot 2 pending

    scheduler.remove(2); // slot 2 failed
    expect(result).toEqual({ openedCount: 2, failedIndices: [2] });
  });

  // Falsifiable: call onFirstSettle again after re-armed slots settle —
  // firedCount would be 2 instead of 1.
  it('fires exactly once regardless of retry re-arming', () => {
    let firedCount = 0;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 2,
      onFirstSettle: ({ failedIndices }) => {
        firedCount += 1;
        for (const i of failedIndices) scheduler.rearmSlot(i);
      },
    });

    scheduler.add({ index: 0 });
    scheduler.remove(1); // triggers onFirstSettle, re-arms slot 1
    scheduler.remove(1); // slot 1 re-settles (retry also failed)
    expect(firedCount).toBe(1);
  });

  // Falsifiable: count only add() calls in openedCount — a slot settled via
  // remove() would be missed, giving a wrong total.
  it('reports correct openedCount and failedIndices', () => {
    let result: { openedCount: number; failedIndices: number[] } | undefined;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 4,
      onFirstSettle: (r) => {
        result = r;
      },
    });

    scheduler.add({ index: 0 });
    scheduler.remove(1);
    scheduler.add({ index: 2 });
    scheduler.remove(3);
    expect(result).toEqual({ openedCount: 2, failedIndices: [1, 3] });
  });
});

describe('scheduler — rearmSlot and the retry-round gate', () => {
  // Falsifiable: make rearmSlot a no-op — re-armed slots are already settled,
  // the gate opens immediately inside onFirstSettle, and acquired is set
  // before the retry slot settles.
  it('gate stays closed across a retry round and opens when retry settles', async () => {
    let retryIndex = -1;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 2,
      onFirstSettle: ({ failedIndices }) => {
        for (const i of failedIndices) {
          retryIndex = i;
          scheduler.rearmSlot(i);
        }
      },
    });

    scheduler.add({ index: 0 }); // slot 0 opens
    scheduler.remove(1); // slot 1 fails → onFirstSettle fires, slot 1 re-armed

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(false); // gate still closed: slot 1 not yet re-settled

    scheduler.add({ index: retryIndex }); // retry slot 1 succeeds (retryIndex===1)
    await flush();
    expect(acquired).toBe(true); // gate open after retry settle
  });

  // Falsifiable: reset gateOpen or firstSettleFired in rearmSlot so the gate
  // can be re-blocked after it has opened — an acquire() after the retry
  // settle would then block indefinitely.
  it('gate is still one-shot after the retry round: a further remove+add does not re-block', async () => {
    const scheduler = createScheduler<TestWorker>({
      poolSize: 2,
      onFirstSettle: ({ failedIndices }) => {
        for (const i of failedIndices) scheduler.rearmSlot(i);
      },
    });

    scheduler.add({ index: 0 });
    scheduler.remove(1); // trigger retry round
    scheduler.add({ index: 1 }); // retry succeeds → gate opens

    // Simulate a post-startup restart on slot 1
    scheduler.remove(1);
    scheduler.add({ index: 1 });

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(true); // gate stays open
  });

  // Falsifiable: call onGateOpen when shutdown() fires inside onFirstSettle
  // (the opened===0 fast-fail path) — onGateOpen would run when it should not.
  it('onGateOpen is not called when shutdown() fires inside onFirstSettle', async () => {
    let gateOpenCalled = false;
    const scheduler = createScheduler<TestWorker>({
      poolSize: 2,
      onFirstSettle: () => {
        void scheduler.shutdown(new Error('startup failed'));
      },
      onGateOpen: () => {
        gateOpenCalled = true;
      },
    });

    scheduler.add({ index: 0 });
    scheduler.remove(1); // all settled → onFirstSettle → shutdown()
    await flush();
    expect(gateOpenCalled).toBe(false);
  });

  // Falsifiable: make rearmSlot work even when the gate is already open —
  // a post-startup remove+rearm+add would then re-block acquire().
  it('rearmSlot is a no-op when the gate is already open', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 1 });
    scheduler.add({ index: 0 }); // gate opens immediately

    scheduler.remove(0); // post-startup death
    scheduler.rearmSlot(0); // must be a no-op
    scheduler.add({ index: 0 }); // revival

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(true); // gate was already open, rearmSlot did nothing
  });
});

/**
 * The abort has to reach a caller that is still QUEUED. Until this existed the
 * signal was only consulted once a worker had been leased, so a pool with
 * nothing to lend could not be abandoned at all — which is how the benchmark
 * page hung for good on OPFSCoopSyncVFS, where one exclusive OPFS handle
 * rotates between workers and a hand-over may never arrive.
 */
describe('scheduler — aborting while queued', () => {
  it('rejects a queued acquisition with the caller’s reason', async () => {
    const { scheduler } = makeScheduler(1);
    await scheduler.acquire('read'); // the only worker is out
    const controller = new AbortController();
    const reason = new Error('gave up waiting');

    const queued = scheduler.acquire('read', controller.signal);
    await flush();
    expect(scheduler.stats().read).toBe(1);

    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    // Falsifiable: reject without splicing and the count stays at 1 — a dead
    // waiter that a later handOver would shift and hand a worker to, losing it.
    expect(scheduler.stats().read).toBe(0);
  });

  it('never queues an acquisition whose signal is already aborted', async () => {
    const { scheduler } = makeScheduler(1);
    await scheduler.acquire('read');
    const reason = new Error('too late');

    await expect(
      scheduler.acquire('read', AbortSignal.abort(reason)),
    ).rejects.toBe(reason);
    expect(scheduler.stats().read).toBe(0);
  });

  it('does not strand the worker an aborted waiter was queued for', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const controller = new AbortController();

    const abandoned = scheduler.acquire('read', controller.signal);
    const next = scheduler.acquire('read');
    await flush();
    controller.abort();
    await expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });

    held.release();
    // The worker goes to the waiter still there, not into the void.
    expect((await next).worker.index).toBe(0);
  });

  it('leaves a lease alone when the abort arrives after it was granted', async () => {
    const { scheduler } = makeScheduler(1);
    const held = await scheduler.acquire('read');
    const controller = new AbortController();

    const queued = scheduler.acquire('read', controller.signal);
    await flush();
    held.release(); // the waiter is served here
    await flush();
    controller.abort(); // too late — the lease is real

    const lease = await queued;
    expect(lease.worker.index).toBe(0);
    lease.release();
    // Falsifiable: reject regardless of whether the waiter was still queued,
    // and this worker never comes back.
    expect((await scheduler.acquire('read')).worker.index).toBe(0);
  });

  it('aborts a queued write without disturbing the writer designation', async () => {
    const { scheduler } = makeScheduler(1);
    const writer = await scheduler.acquire('write');
    const controller = new AbortController();

    const queued = scheduler.acquire('write', controller.signal);
    await flush();
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    expect(scheduler.stats().write).toBe(0);

    writer.release();
    const next = await scheduler.acquire('write');
    expect(next.worker.index).toBe(0);
  });
});

describe('scheduler — the last writer is preferred', () => {
  /**
   * Pushes the write designation off index 0 by holding index 0 with a read
   * while the write acquires. Without this the writer IS index 0, where
   * "prefer the last writer" and "lowest index first" name the same worker and
   * nothing here would discriminate.
   */
  const withWriterAtOne = async () => {
    const { scheduler, workers } = makeScheduler(2);
    const held = await scheduler.acquire('read');
    const wrote = await scheduler.acquire('write');
    expect(held.worker.index).toBe(0);
    expect(wrote.worker.index).toBe(1);
    held.release();
    wrote.release();
    await flush();
    return { scheduler, workers };
  };

  // Falsifiable: delete the lastWriterIndex branch from takeAvailable and this
  // goes red — the read takes worker 0, which is what the lowest-index scan
  // has always done.
  it('gives a read the worker that wrote last, not the lowest index', async () => {
    const { scheduler } = await withWriterAtOne();

    const read = await scheduler.acquire('read');
    expect(read.worker.index).toBe(1);
  });

  // Falsifiable: delete the same branch — the write then falls through to the
  // lowest-index scan and takes worker 0, claiming a fresh designation there.
  it('gives a new write the worker that wrote last', async () => {
    const { scheduler } = await withWriterAtOne();

    const write = await scheduler.acquire('write');
    expect(write.worker.index).toBe(1);
  });

  // The guard that keeps this a preference and not a pin: a busy last writer
  // is skipped, never waited for. Falsifiable by making the branch return
  // undefined instead of falling through — the read would then queue.
  it('falls back to the lowest index when the last writer is busy', async () => {
    const { scheduler } = await withWriterAtOne();

    const onLastWriter = await scheduler.acquire('read');
    expect(onLastWriter.worker.index).toBe(1);

    const next = await scheduler.acquire('read');
    expect(next.worker.index).toBe(0);
  });

  // The slot is REUSED, and that is the whole test. Stopping at `remove(1)`
  // proves nothing: remove() also drops the index from `available`, and the
  // preference tests that set before it dereferences the hint — so the read
  // would land on worker 0 whether or not the hint was cleared. Only a worker
  // re-added at index 1 makes the stale hint reachable again.
  //
  // Falsifiable: delete `if (lastWriterIndex === index) lastWriterIndex = -1;`
  // from remove() — the read is then routed to the respawned worker, which is a
  // different connection with a fresh epoch and has seen nothing.
  it('forgets the last writer when that index is respawned', async () => {
    const { scheduler } = await withWriterAtOne();

    scheduler.remove(1);
    scheduler.add({ index: 1 });

    const read = await scheduler.acquire('read');
    expect(read.worker.index).toBe(0);
  });
});

describe('scheduler — readiness gate', () => {
  // Falsifiable: remove the gate await from acquire() and the acquired flag is
  // set before slot 1 settles, because a worker is already available.
  it('acquire() does not resolve while at least one slot is unsettled', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 }); // slot 0 ready; slot 1 still pending

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(false); // gate not yet open

    scheduler.add({ index: 1 }); // slot 1 settles → gate opens
    await flush();
    expect(acquired).toBe(true);
  });

  // Falsifiable: count only add() calls in settleGateSlot — a dead slot never
  // opens the gate, and acquired stays false after the remove().
  it('a slot settled by remove() counts: a pool where one slot dies and the rest are ready still serves', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 }); // slot 0 ready
    scheduler.remove(1); // slot 1 died → gate opens

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(true);
  });

  // Falsifiable: reset settledSlots or gateOpen in remove() so the restart
  // re-blocks the gate — acquired stays false after the restart cycle.
  it('gate is one-shot: after opening, a remove()+add() cycle does not re-block acquire()', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 });
    scheduler.add({ index: 1 }); // gate opens

    // Simulate a worker restart.
    scheduler.remove(1);
    scheduler.add({ index: 1 });

    let acquired = false;
    void scheduler.acquire('read').then((l) => {
      acquired = true;
      l.release();
    });
    await flush();
    expect(acquired).toBe(true);
  });

  // Falsifiable: do not reject gateDeferred in shutdown() — the caller hangs
  // on gateDeferred.promise for ever.
  it('shutdown(reason) rejects a caller that is waiting on the gate', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 }); // slot 1 still pending → gate not open

    const reason = new Error('closing');
    const pending = scheduler.acquire('read');
    await flush();
    void scheduler.shutdown(reason);
    await expect(pending).rejects.toBe(reason);
  });

  // Falsifiable: remove the `if (shutdownReason) throw shutdownReason` re-check
  // after the gate await. remove() settles the gate (resolve) synchronously
  // before failClient runs, so the gate resolves a microtask before shutdown
  // sets shutdownReason. Without the re-check the caller falls through to
  // takeAvailable (no workers), pushes to a queue already drained by shutdown,
  // and hangs forever.
  it('shutdown fires in the same tick as the gate resolve: caller is still rejected', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 1 });

    const reason = new Error('fail-client');
    const pending = scheduler.acquire('read');
    // settle the gate via remove(), then shutdown in the same synchronous tick
    scheduler.remove(0);
    void scheduler.shutdown(reason);

    await expect(pending).rejects.toBe(reason);
  });

  // Falsifiable: remove the abort race from the gate-await block — the caller
  // hangs on the gate indefinitely when its signal fires first.
  it('an AbortSignal aborted while waiting on the gate rejects that caller', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 }); // gate not yet open

    const controller = new AbortController();
    const reason = new Error('aborted while waiting for gate');
    const pending = scheduler.acquire('read', controller.signal);
    await flush();
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe('scheduler — callers waiting on the readiness gate are counted', () => {
  // A caller blocked on the gate sits in NEITHER wait queue: it is suspended
  // before takeAvailable is ever reached. Without its own counter the debug
  // surface reads "nothing is waiting" for the whole startup window, which is
  // exactly when someone is looking.
  //
  // Falsifiable: remove the `gatedWaiters += 1` from the gate block — `gated`
  // then stays 0 while the caller below is demonstrably still waiting.
  it('counts a gate waiter, and stops counting once the gate serves it', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 }); // slot 1 still pending → gate closed
    expect(scheduler.stats().gated).toBe(0);

    let served = false;
    void scheduler.acquire('read').then((lease) => {
      served = true;
      lease.release();
    });
    await flush();

    // The distinction the counter exists for: waiting for the pool to EXIST is
    // not waiting for a free worker, and `read` cannot see the first.
    expect(scheduler.stats().read).toBe(0);
    expect(scheduler.stats().gated).toBe(1);

    scheduler.add({ index: 1 }); // gate opens
    await flush();
    expect(served).toBe(true);
    expect(scheduler.stats().gated).toBe(0);
  });

  // Falsifiable: move the `gatedWaiters -= 1` out of the `finally` and onto the
  // success path — an aborted waiter then leaks its count for ever and this
  // reads 1.
  it('stops counting a waiter whose signal aborts on the gate', async () => {
    const scheduler = createScheduler<TestWorker>({ poolSize: 2 });
    scheduler.add({ index: 0 });

    const controller = new AbortController();
    const pending = scheduler.acquire('read', controller.signal);
    await flush();
    expect(scheduler.stats().gated).toBe(1);

    controller.abort(new Error('caller gave up'));
    await expect(pending).rejects.toThrow();
    expect(scheduler.stats().gated).toBe(0);
  });
});
