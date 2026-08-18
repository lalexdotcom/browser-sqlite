/**
 * Pure worker scheduling: availability, wait queues, writer designation.
 *
 * This module is deliberately free of `Worker`, DOM and orchestrator imports so
 * it can be exercised by fast Node tests. B1 survived for months because the
 * scheduler was only reachable through slow browser tests.
 */

/**
 * A borrowed worker. `release()` is the only way back into the pool and is
 * idempotent — a second call is a no-op, not an error.
 */
export type Lease<W> = {
  readonly worker: W;
  release: () => void;
};

export type Scheduler<W> = {
  add: (worker: W) => void;
  acquire: (kind: 'read' | 'write') => Promise<Lease<W>>;
};

/**
 * Creates a scheduler over workers identified by a numeric `index`.
 *
 * @param opts.onIdle - Called when a released worker returns to the available
 *   set with nothing queued behind it. The client wires the orchestrator's
 *   `READY` status here; the scheduler itself knows nothing about shared memory.
 */
export const createScheduler = <W extends { index: number }>(
  opts: { onIdle?: (worker: W) => void } = {},
): Scheduler<W> => {
  const workers: W[] = [];

  // Availability lives HERE and nowhere else. No worker carries an `available`
  // flag, so no other module can republish a borrowed worker — which is exactly
  // how B1 happened.
  const available = new Set<number>();

  const readerQueue: Array<(worker: W) => void> = [];
  const writerQueue: Array<(worker: W) => void> = [];

  // Index of the worker designated for writes, or -1 when none is designated.
  let currentWriterIndex = -1;

  const handOver = (worker: W) => {
    // Writers first, but only onto the designated writer (or when no writer is
    // designated yet).
    if (
      writerQueue.length &&
      (currentWriterIndex === worker.index || currentWriterIndex === -1)
    ) {
      // Claim the designation before serving. The original code omitted this,
      // so a later write acquisition could designate a second writer while this
      // one was still running.
      currentWriterIndex = worker.index;
      writerQueue.shift()?.(worker);
      return;
    }

    if (readerQueue.length) {
      if (currentWriterIndex === worker.index) currentWriterIndex = -1;
      readerQueue.shift()?.(worker);
      return;
    }

    available.add(worker.index);
    opts.onIdle?.(worker);
  };

  const makeLease = (worker: W): Lease<W> => {
    let released = false;
    return {
      worker,
      release: () => {
        if (released) return;
        released = true;
        handOver(worker);
      },
    };
  };

  const takeAvailable = (write: boolean): W | undefined => {
    if (write && currentWriterIndex > -1) {
      if (!available.has(currentWriterIndex)) return undefined;
      available.delete(currentWriterIndex);
      return workers[currentWriterIndex];
    }

    // Lowest-index-first, preserved from the original implementation.
    const found = workers.find((worker) => available.has(worker.index));
    if (!found) return undefined;

    available.delete(found.index);
    if (write) currentWriterIndex = found.index;
    return found;
  };

  return {
    add: (worker) => {
      workers[worker.index] = worker;
      available.add(worker.index);
    },

    acquire: async (kind) => {
      const write = kind === 'write';

      const immediate = takeAvailable(write);
      if (immediate) return makeLease(immediate);

      const { promise, resolve } = Promise.withResolvers<W>();
      (write ? writerQueue : readerQueue).push(resolve);
      return makeLease(await promise);
    },
  };
};
