/**
 * Pure worker scheduling: availability, wait queues, writer designation.
 *
 * This module is deliberately free of `Worker` and DOM imports so
 * it can be exercised by fast Node tests. B1 survived for months because the
 * scheduler was only reachable through slow browser tests.
 */

import type { CreateSQLiteClientOptions } from './client';

/**
 * A borrowed worker. `release()` is the only way back into the pool and is
 * idempotent — a second call is a no-op, not an error.
 */
export type Lease<W> = {
  readonly worker: W;
  release: () => void;
};

/**
 * Decides whether a worker index may hold the write designation. The default
 * accepts every index, so production behaviour is exactly what it was.
 */
export type WriterPolicy = (index: number) => boolean;

/**
 * TEST-ONLY, UNSUPPORTED, removable without notice.
 *
 * The barrier's browser test needs the failing configuration — writer not on
 * the worker that serves the read — to be deterministic; at startup chance it
 * occurs ~3 runs in 10. This type is declared here, and NOT in `client.ts`,
 * because `src/index.ts` re-exports only `./client` and `./errors`: keeping it
 * out of that path keeps it out of the published `.d.ts` and out of every
 * consumer's autocompletion. `CreateSQLiteClientOptions` is pulled in with
 * `import type`, which is erased at build time and creates no runtime cycle.
 *
 * A predicate that refuses every index leaves writes queued forever — use it
 * with `poolSize >= 2`.
 */
export type InternalSQLiteClientOptions = CreateSQLiteClientOptions & {
  __unsafeTestWriterPolicy?: WriterPolicy;
};

export type Scheduler<W> = {
  add: (worker: W) => void;
  /**
   * Leases a worker, queueing when none is free.
   *
   * `signal` aborts the WAIT, and only the wait: it rejects with
   * `signal.reason` while the request is still queued, and is ignored once a
   * lease has been granted — from that point the caller owns the worker and
   * owes a `release()`. Without it an abort could not land at all while the
   * pool had nothing to lend, which is the state a VFS rotating one exclusive
   * OPFS handle can stay in indefinitely.
   */
  acquire: (kind: 'read' | 'write', signal?: AbortSignal) => Promise<Lease<W>>;
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
  /**
   * Read-only counters for the debug subsystem. The scheduler stays pure: it
   * exposes numbers and knows nothing about debug (spec §3.2).
   */
  stats: () => {
    read: number;
    write: number;
    available: number;
    leased: number;
    /**
     * Callers suspended on the readiness gate. They are in NEITHER wait queue —
     * the gate is awaited before `takeAvailable` is ever reached — so `read`
     * and `write` cannot see them, and without this the debug surface reports
     * an idle pool for the whole startup window.
     *
     * Waiting for the pool to *exist* is a different wait from waiting for a
     * free worker, which is why this is its own counter and not folded in.
     */
    gated: number;
  };
  /**
   * Removes a slot from the settled-set so that its next `add()` or `remove()`
   * call counts again toward opening the readiness gate. Only effective while
   * the gate is still closed; a no-op once the gate has opened.
   *
   * Used by the startup retry round: the client re-arms the failed slots so
   * the gate stays closed until the retry slots have settled.
   */
  rearmSlot: (index: number) => void;
};

/**
 * Creates a scheduler over workers identified by a numeric `index`.
 *
 * @param opts.onIdle - Called when a released worker returns to the available
 *   set with nothing queued behind it. The scheduler itself knows nothing about
 *   worker state.
 */
export const createScheduler = <W extends { index: number }>(
  opts: {
    onIdle?: (worker: W) => void;
    canDesignateWriter?: WriterPolicy;
    /**
     * Total number of worker slots the pool will spawn. Once every slot has
     * settled (via `add` when it becomes ready, or via `remove` when it dies or
     * fails to open), a one-shot gate is lifted and `acquire()` may proceed.
     * Omit or pass 0 for an immediately-open gate (tests and single-shot use).
     */
    poolSize?: number;
    /**
     * Called exactly once when every slot in [0, poolSize) has settled for the
     * first time. Fires before the gate opens so the callback can call
     * `rearmSlot()` to extend the wait for a retry round.
     *
     * `openedCount` — slots that settled via `add()` (became ready).
     * `failedIndices` — slots that settled via `remove()` (died / timed out).
     */
    onFirstSettle?: (result: {
      openedCount: number;
      failedIndices: number[];
    }) => void;
    /**
     * Called when the readiness gate resolves (opens). Not called when the gate
     * is rejected via `shutdown()`. Use this to clear any startup-pending flag
     * after the retry round (if any) has fully settled.
     */
    onGateOpen?: () => void;
  } = {},
): Scheduler<W> => {
  const workers: (W | undefined)[] = [];

  // Availability lives HERE and nowhere else. No worker carries an `available`
  // flag, so no other module can republish a borrowed worker — which is exactly
  // how B1 happened.
  //
  // A second guarantee rests on this set, and nothing about it is visible from
  // here. A leased worker leaves `available` until `release()` puts it back, so
  // exactly one query is ever in flight per worker. `worker/statement-cache.ts`
  // is built on that and takes no lock of any kind: its statements outlive the
  // query that compiled them, and are reset and cleared on the way out. Lend a
  // worker to a second concurrent caller and that reset lands on a statement
  // another query is part-way through — rewound cursor, cleared bindings, wrong
  // rows — while losing a worker can finalise a handle that other query still
  // holds, which is a use-after-free on a `sqlite3_stmt` pointer. Before the
  // cache, breaking this was merely confusing.
  const available = new Set<number>();

  const dead = new Set<number>();
  const leased = new Set<number>();
  // Per-index generation counter. Bumped by remove() so that a release() from
  // a lease created before the remove can detect it is stale and do nothing.
  const generations = new Map<number, number>();
  const gen = (index: number) => generations.get(index) ?? 0;

  let shutdownReason: Error | undefined;
  let shutdownDeferred: PromiseWithResolvers<void> | undefined;

  // One-shot readiness gate: lifts once every slot in [0, poolSize) has
  // settled — either via add() (ready) or remove() (died / failed to open).
  // poolSize 0 or absent → gate is open from the start.
  //
  // Genuinely one-shot: once gateOpen is true it stays true. A worker that
  // restarts (remove → add) after the gate has lifted must not re-block callers
  // already in flight.
  const settledSlots = new Set<number>();
  let gateOpen = (opts.poolSize ?? 0) === 0;
  const gateDeferred = Promise.withResolvers<void>();
  if (gateOpen) gateDeferred.resolve();
  // Suppress unhandled-rejection when shutdown() fires before any acquire()
  // has attached a handler. Each awaiting acquire() still sees the rejection.
  void gateDeferred.promise.catch(() => {});

  // Tracks slots that settled via add() (became ready) in the first round,
  // used to compute openedCount/failedIndices for onFirstSettle.
  const firstSettleOpened = new Set<number>();
  let firstSettleFired = false;

  // Callers currently suspended on the gate. See `stats().gated`.
  let gatedWaiters = 0;

  const settleGateSlot = (index: number, kind: 'opened' | 'failed') => {
    if (gateOpen || settledSlots.has(index)) return;
    settledSlots.add(index);
    if (kind === 'opened') firstSettleOpened.add(index);
    if (settledSlots.size < (opts.poolSize ?? 0)) return;

    // All slots have now settled (first round or retry round).
    if (opts.onFirstSettle && !firstSettleFired) {
      firstSettleFired = true;
      const failedIndices = [...settledSlots].filter(
        (i) => !firstSettleOpened.has(i),
      );
      opts.onFirstSettle({
        openedCount: firstSettleOpened.size,
        failedIndices,
      });
      // After the callback the client may have:
      //   (a) called rearmSlot() for retry slots → settledSlots.size < poolSize,
      //       gate stays closed; or
      //   (b) called shutdown() (opened===0 fast-fail) → shutdownReason is set.
      // In both cases skip the resolve/open below.
      if (settledSlots.size < (opts.poolSize ?? 0) || shutdownReason) return;
    }

    gateOpen = true;
    gateDeferred.resolve();
    opts.onGateOpen?.();
  };

  const readerQueue: Array<{
    resolve: (worker: W) => void;
    reject: (error: Error) => void;
  }> = [];
  const writerQueue: Array<{
    resolve: (worker: W) => void;
    reject: (error: Error) => void;
  }> = [];

  // Index of the worker designated for writes, or -1 when none is designated.
  //
  // The designation exists to serialize writes onto one connection, and it
  // lasts no longer than that: handOver releases it as soon as no write is
  // queued behind it, so `designated` and `leased` coincide. It was sticky for
  // the life of the worker until wave 4's barrier shipped — a write landing on
  // a worker that had not absorbed the previous commit failed at `prepare` with
  // `no such table`. `applyBarrier` covers `kind: 'write'`, so a newly
  // designated writer catches up before it prepares anything.
  //
  // Measured 2026-08-21: with a long read holding worker 0, five writes took
  // 30 ms spread over worker 1 against 934-1052 ms pinned behind the read.
  let currentWriterIndex = -1;

  /**
   * The worker that most recently held the write designation, kept after that
   * designation is released. `currentWriterIndex` answers "who may write now";
   * this answers "who has already seen the last commit", which outlives it.
   */
  let lastWriterIndex = -1;

  const canDesignate = opts.canDesignateWriter ?? (() => true);

  /**
   * Serves the writer queue from `worker` when it may hold the designation.
   * Extracted because `handOver` and `add` carried this branch twice, and a
   * predicate that lives in only one of the two copies is a silent hole.
   */
  const serveWriterFirst = (worker: W): boolean => {
    if (!writerQueue.length) return false;
    if (currentWriterIndex !== worker.index && currentWriterIndex !== -1)
      return false;
    // An already-designated writer is not re-judged; only a NEW designation is.
    if (currentWriterIndex === -1 && !canDesignate(worker.index)) return false;
    // Claim the designation before serving: without this, a later write
    // acquisition could designate a second writer while this one still runs.
    currentWriterIndex = worker.index;
    lastWriterIndex = worker.index;
    writerQueue.shift()?.resolve(worker);
    return true;
  };

  const checkShutdown = () => {
    if (shutdownDeferred && leased.size === 0) shutdownDeferred.resolve();
  };

  const handOver = (worker: W) => {
    if (serveWriterFirst(worker)) return;

    // Release the designation. Reaching this line proves no write is queued:
    // serveWriterFirst's only negative exit that leaves the designation on this
    // worker is an empty writerQueue. It sits ABOVE the reader branch because
    // that branch returns — the release has to happen on every exit, not only
    // the idle one.
    //
    // Measured, so nobody "fixes" it: moving this above serveWriterFirst is
    // behaviourally equivalent in production, since the call reclaims the
    // designation on the same worker at once. The two differ only under a
    // canDesignateWriter that refuses this index — tests only.
    if (currentWriterIndex === worker.index) currentWriterIndex = -1;

    if (readerQueue.length) {
      // Reads never alter the designation — rule 1.
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

    // Prefer the worker that wrote last, for a read and for a new designation
    // alike. A read served there skips the barrier, that worker having already
    // seen the commit; a write served there keeps a run of writes on one
    // connection instead of walking the pool between batches.
    //
    // A PREFERENCE, never a pin: it picks only among workers that are already
    // available, so it can never make anything wait. That is what keeps it
    // clear of the measurement above — which was about writes queued BEHIND a
    // busy designated writer, not about which free worker to choose.
    //
    // `workers[-1]` is undefined, so the unset case needs no separate guard.
    const preferred = workers[lastWriterIndex];
    if (
      preferred !== undefined &&
      available.has(lastWriterIndex) &&
      (!write || canDesignate(lastWriterIndex))
    ) {
      available.delete(lastWriterIndex);
      if (write) currentWriterIndex = lastWriterIndex;
      return preferred;
    }

    // Lowest-index-first for both reads and new writes (reads never touch
    // the designation; write designation is set below when a new one starts).
    const found = workers.find(
      (worker) =>
        worker !== undefined &&
        available.has(worker.index) &&
        (!write || canDesignate(worker.index)),
    );
    if (!found) return undefined;

    available.delete(found.index);
    if (write) {
      currentWriterIndex = found.index;
      lastWriterIndex = found.index;
    }
    return found;
  };

  return {
    add: (worker) => {
      // Settle this slot in the gate (first call per index only; restarts are
      // ignored because gateOpen is already true by then).
      settleGateSlot(worker.index, 'opened');

      dead.delete(worker.index);
      workers[worker.index] = worker;
      // Serve any requests that arrived before this worker was ready, preserving
      // the same writer-first priority as handOver. Does NOT call onIdle — the
      // worker is newly joining the pool, not returning from a lease.
      if (serveWriterFirst(worker)) return;
      if (readerQueue.length) {
        // Reads never alter the designation — rule 1.
        readerQueue.shift()?.resolve(worker);
        return;
      }
      available.add(worker.index);
    },

    remove: (index) => {
      // Settle this slot in the gate — a dead slot counts. First call per
      // index only; a restart after the gate is open is a no-op here.
      settleGateSlot(index, 'failed');

      dead.add(index);
      available.delete(index);
      leased.delete(index);
      workers[index] = undefined;
      // Bump the generation so any outstanding lease on this index knows it is
      // stale when its release() eventually fires.
      generations.set(index, gen(index) + 1);
      if (currentWriterIndex === index) currentWriterIndex = -1;
      // A respawned slot is a different connection with a fresh epoch, so the
      // freshness hint this index carried is void.
      if (lastWriterIndex === index) lastWriterIndex = -1;
      checkShutdown();
    },

    shutdown: (reason) => {
      // Reject the gate so any caller blocked on it gets the shutdown error.
      if (!gateOpen) {
        gateOpen = true;
        gateDeferred.reject(reason);
      }
      shutdownReason ??= reason;
      shutdownDeferred ??= Promise.withResolvers<void>();
      for (const waiter of readerQueue.splice(0)) waiter.reject(reason);
      for (const waiter of writerQueue.splice(0)) waiter.reject(reason);
      checkShutdown();
      return shutdownDeferred.promise;
    },

    stats: () => ({
      read: readerQueue.length,
      write: writerQueue.length,
      available: available.size,
      leased: leased.size,
      gated: gatedWaiters,
    }),

    rearmSlot: (index) => {
      if (!gateOpen) settledSlots.delete(index);
    },

    acquire: async (kind, signal) => {
      if (shutdownReason) throw shutdownReason;
      // Before the queue, not after: a caller who has already given up must not
      // take a place in line and be served a worker nobody will release.
      signal?.throwIfAborted();

      // Readiness gate: block until every slot has settled. The gate is
      // one-shot — once open it never closes, so this branch is never re-entered
      // by callers already in flight after a worker restarts.
      if (!gateOpen) {
        // In a `finally`, so an abort or a shutdown rejection decrements too:
        // a leaked count would make the pool look permanently congested.
        gatedWaiters += 1;
        try {
          // The tie is settled by microtask order, and it settles in favour of
          // the gate: `resolve()` queues its reaction before a synchronous
          // `abort()` queues `abortP`'s, so a caller aborted in the very tick
          // the last slot settles still gets its lease. That is the queue
          // path's behaviour too — `onAbort` there returns early once the
          // waiter has been shifted — so the two agree rather than diverge.
          if (signal) {
            const { promise: abortP, reject: abortReject } =
              Promise.withResolvers<void>();
            const onGateAbort = () => abortReject(signal.reason);
            signal.addEventListener('abort', onGateAbort, { once: true });
            try {
              await Promise.race([gateDeferred.promise, abortP]);
            } finally {
              signal.removeEventListener('abort', onGateAbort);
            }
          } else {
            await gateDeferred.promise;
          }
        } finally {
          gatedWaiters -= 1;
        }
      }

      // Re-check after the gate: shutdown() may have fired while we waited
      // (remove() settles the gate synchronously before failClient can run, so
      // the gate resolves a microtask before shutdown() sets shutdownReason).
      if (shutdownReason) throw shutdownReason;

      const write = kind === 'write';

      const immediate = takeAvailable(write);
      if (immediate) return makeLease(immediate);

      const { promise, resolve, reject } = Promise.withResolvers<W>();
      const queue = write ? writerQueue : readerQueue;
      const waiter = { resolve, reject };
      queue.push(waiter);

      if (!signal) return makeLease(await promise);

      const onAbort = () => {
        const at = queue.indexOf(waiter);
        // The guard is the whole correctness of this branch, in both
        // directions. A waiter still in the queue is REMOVED, never merely
        // rejected in place: the drains take the head with `shift()`, so a
        // dead entry left behind would be handed a worker that nobody then
        // releases. And a waiter already shifted is left alone: its lease is
        // real, the caller owes a release for it, and rejecting here would
        // strand that worker for the life of the client. The in-query abort
        // race in `queries.ts` covers what happens after the lease.
        //
        // Read-then-mutate needs no lock: this is one synchronous block with
        // no await and no yield, and the drains (`handOver`, `serveWriterFirst`)
        // are synchronous too, so nothing can shift this waiter out between the
        // lookup and the removal. `splice` before `reject` for the same reason
        // read the other way — `reject` only schedules a microtask, but the
        // queue is left consistent before anything else can observe it.
        const queued = at !== -1;
        if (!queued) return;
        queue.splice(at, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        return makeLease(await promise);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
};
