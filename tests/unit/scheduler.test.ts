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
