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
  /**
   * Takes a worker out of the pool for good. A lease already outstanding on
   * that index becomes inert: its `release()` neither hands the worker back nor
   * counts towards `shutdown()`'s wait.
   */
  remove: (index: number) => void;
  /**
   * Closes the front door. Queued waiters reject with `reason`, later
   * acquisitions reject the same way, and the returned promise settles when the
   * last outstanding lease has come back.
   */
  shutdown: (reason: Error) => Promise<void>;
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
  const workers: (W | undefined)[] = [];

  // Availability lives HERE and nowhere else. No worker carries an `available`
  // flag, so no other module can republish a borrowed worker — which is exactly
  // how B1 happened.
  const available = new Set<number>();

  const dead = new Set<number>();
  const leased = new Set<number>();
  // Per-index generation counter. Bumped by remove() so that a release() from
  // a lease created before the remove can detect it is stale and do nothing.
  const generations = new Map<number, number>();
  const gen = (index: number) => generations.get(index) ?? 0;

  let shutdownReason: Error | undefined;
  let shutdownDeferred: PromiseWithResolvers<void> | undefined;

  const readerQueue: Array<{
    resolve: (worker: W) => void;
    reject: (error: Error) => void;
  }> = [];
  const writerQueue: Array<{
    resolve: (worker: W) => void;
    reject: (error: Error) => void;
  }> = [];

  // Index of the worker designated for writes, or -1 when none is designated.
  let currentWriterIndex = -1;

  const checkShutdown = () => {
    if (shutdownDeferred && leased.size === 0) shutdownDeferred.resolve();
  };

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
      writerQueue.shift()?.resolve(worker);
      return;
    }

    if (readerQueue.length) {
      if (currentWriterIndex === worker.index) currentWriterIndex = -1;
      readerQueue.shift()?.resolve(worker);
      return;
    }

    available.add(worker.index);
    opts.onIdle?.(worker);
  };

  const makeLease = (worker: W): Lease<W> => {
    leased.add(worker.index);
    const myGen = gen(worker.index);
    let released = false;
    return {
      worker,
      release: () => {
        if (released) return;
        released = true;
        if (gen(worker.index) !== myGen) {
          // Stale lease: remove() was called after this lease was created,
          // bumping the generation. Handing the worker back would corrupt the
          // pool (it could be held by a new lease on the revived slot).
          checkShutdown();
          return;
        }
        leased.delete(worker.index);
        handOver(worker);
        checkShutdown();
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
    const found = workers.find(
      (worker) => worker !== undefined && available.has(worker.index),
    );
    if (!found) return undefined;

    available.delete(found.index);
    if (write) currentWriterIndex = found.index;
    return found;
  };

  return {
    add: (worker) => {
      dead.delete(worker.index);
      workers[worker.index] = worker;
      // Serve any requests that arrived before this worker was ready, preserving
      // the same writer-first priority as handOver. Does NOT call onIdle — the
      // worker is newly joining the pool, not returning from a lease.\
      if (
        writerQueue.length &&
        (currentWriterIndex === worker.index || currentWriterIndex === -1)
      ) {
        currentWriterIndex = worker.index;
        writerQueue.shift()?.resolve(worker);
        return;
      }
      if (readerQueue.length) {
        if (currentWriterIndex === worker.index) currentWriterIndex = -1;
        readerQueue.shift()?.resolve(worker);
        return;
      }
      available.add(worker.index);
    },

    remove: (index) => {
      dead.add(index);
      available.delete(index);
      leased.delete(index);
      workers[index] = undefined;
      // Bump the generation so any outstanding lease on this index knows it is
      // stale when its release() eventually fires.
      generations.set(index, gen(index) + 1);
      if (currentWriterIndex === index) currentWriterIndex = -1;
      checkShutdown();
    },

    shutdown: (reason) => {
      shutdownReason ??= reason;
      shutdownDeferred ??= Promise.withResolvers<void>();
      for (const waiter of readerQueue.splice(0)) waiter.reject(reason);
      for (const waiter of writerQueue.splice(0)) waiter.reject(reason);
      checkShutdown();
      return shutdownDeferred.promise;
    },

    acquire: async (kind) => {
      if (shutdownReason) throw shutdownReason;
      const write = kind === 'write';

      const immediate = takeAvailable(write);
      if (immediate) return makeLease(immediate);

      const { promise, resolve, reject } = Promise.withResolvers<W>();
      (write ? writerQueue : readerQueue).push({ resolve, reject });
      return makeLease(await promise);
    },
  };
};
