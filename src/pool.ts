import { SQLiteError } from './errors';
import { type WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import type { SQLiteVFS, WorkerMessageData } from './types';

/**
 * Query execution options forwarded to a pool worker.
 */
export type PoolWorkerQueryOptions = {
  id?: string;
  chunkSize?: number;
  debug?: string;
};

/**
 * A Worker extended with pool-specific properties.
 *
 * Note: no `available` field — availability lives in the Scheduler, not on
 * the worker itself. This makes it impossible to republish a borrowed worker
 * from outside the scheduler (the root cause of B1).
 */
export type PoolWorker = Worker & {
  index: number;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: PoolWorkerQueryOptions,
  ) => AsyncGenerator<T[] | number>;
  /**
   * Ask the worker to stop. Also settles a `next()` already in flight, which
   * is what lets the consumer's queued `return()` reach the generator's
   * finally instead of waiting behind a chunk that may be minutes away.
   */
  interrupt: () => void;
  /** Resolves when no query is in flight on this worker. */
  quiesce: () => Promise<void>;
};

const STOP = Symbol('stop');

/**
 * Creates a new pool worker and registers it in the pool array.
 * Sets up message routing via callId for query responses.
 *
 * Moved verbatim from `createWorker` in client.ts, with three changes:
 *  1. Closure variables become explicit `deps` parameters.
 *  2. Both `available` assignments are deleted (availability lives in the Scheduler).
 *  3. `worker.available = false/true` in the `query` generator are deleted.
 */
export const createPoolWorker = (deps: {
  index: number;
  orchestrator: WorkerOrchestrator;
  pool: (PoolWorker | undefined)[];
  clientPrefix: string;
  file: string;
  vfs: SQLiteVFS;
  pragmas?: Record<string, string>;
  onDeath?: (index: number, error: SQLiteError) => void;
  onServed?: (index: number) => void;
  drainTimeout: number;
}): Promise<PoolWorker> => {
  const { index, orchestrator, pool, clientPrefix, file, vfs, pragmas } = deps;

  const deferredInit = Promise.withResolvers<PoolWorker>();

  const workerName = `${clientPrefix} / Worker ${index + 1}`;
  const worker = Object.assign(
    new Worker(
      /* webpackChunkName: "browser-sqlite" */ new URL(
        './worker/worker.js',
        import.meta.url,
      ),
      { name: workerName, type: 'module' },
    ) as PoolWorker,
    { index },
  );
  pool[index] = worker;

  // Debug hooks — wired up per-client in a future task; currently always undefined.
  const createWorkerDebugState = undefined as
    | ((i: number, name: string) => any)
    | undefined;
  const createQueryDebugState = undefined as
    | ((i: number, sql: string, params?: unknown[]) => any)
    | undefined;

  const state = createWorkerDebugState?.(index, workerName);

  let currentCallId = 0;

  // Deferred promise for streaming query results one chunk at a time
  let deferredChunk: PromiseWithResolvers<unknown[] | number> | undefined;

  // Resolved while a query is in flight; `quiesce()` is how a lease learns the
  // worker is genuinely idle again.
  let idle: PromiseWithResolvers<void> | undefined;
  let stopRequested: PromiseWithResolvers<typeof STOP> | undefined;

  let dead = false;
  let ready = false;
  const deathDeferred = Promise.withResolvers<never>();
  // Nothing awaits this until a query runs; without a sink an early death is an
  // unhandled rejection.
  deathDeferred.promise.catch(() => {});

  // Per-query channel for a message that never arrived (onmessageerror). The
  // worker is alive, so the request rejects but the transport stays intact and
  // the generator's finally still stops and drains it.
  let lost: PromiseWithResolvers<never> | undefined;

  const workerUrl = new URL('./worker/worker.js', import.meta.url).href;

  const die = (error: SQLiteError) => {
    if (dead) return;
    dead = true;
    deathDeferred.reject(error);
    deferredInit.reject(error); // no-op once resolved
    deps.onDeath?.(index, error);
  };

  worker.onerror = (event) => {
    const errorEvent = event as ErrorEvent;
    const detail =
      typeof event === 'object' && event !== null && 'message' in event
        ? String(errorEvent.message ?? '')
        : '';
    // Chrome's onerror for Worker script-load failures leaves ErrorEvent.filename
    // empty; fall back to the URL this library passed to the Worker constructor.
    const failedUrl = errorEvent.filename || workerUrl;
    die(
      new SQLiteError(
        'WORKER_CRASHED',
        ready
          ? `Worker ${index + 1} failed: ${detail || 'uncaught error'}`
          : `browser-sqlite could not load its worker from ${failedUrl}. ` +
              `If that URL 404s, your bundler did not emit the worker beside your build output — ` +
              `see the "Bundler Configuration" section of the browser-sqlite README. ${detail}`,
        { cause: event },
      ),
    );
  };

  worker.addEventListener('messageerror', () => {
    lost?.reject(
      new SQLiteError(
        'PROTOCOL_ERROR',
        `Worker ${index + 1} sent a message that could not be deserialized; the request cannot be completed.`,
      ),
    );
  });

  // Message handler routes responses by callId
  worker.onmessage = ({ data }: MessageEvent<WorkerMessageData>) => {
    const { callId, type } = data;
    if (callId === 0 && type === 'ready') {
      ready = true;
      if (state) state.initializationTime = Date.now();
      deferredInit.resolve(worker);
    }
    if (callId === 0 && data.type === 'open-error') {
      die(
        new SQLiteError('WORKER_CRASHED', data.message, { cause: data.cause }),
      );
      return;
    }
    if (deferredChunk && callId === currentCallId) {
      switch (type) {
        case 'chunk': {
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.firstRowTime ??= Date.now();
          }
          deferredChunk.resolve(data.data);
          deferredChunk = Promise.withResolvers<unknown[] | number>();
          break;
        }
        case 'done': {
          const affected = data.affected;
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.affectedRows = affected;
            state.currentRequest.affectedRows += affected;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          deferredChunk.resolve(affected);
          deferredChunk = undefined;
          deps.onServed?.(index);
          break;
        }
        case 'error': {
          const error = new Error(data.message, { cause: data.cause });
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.error = error;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          deferredChunk.reject(error);
          deferredChunk = undefined;
          break;
        }
      }
    }
  };

  /**
   * Generator function that executes a query and streams results.
   * Manages the deferredChunk protocol and abort signals.
   */
  const query = async function* <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: PoolWorkerQueryOptions,
  ): AsyncGenerator<T[] | number> {
    try {
      if (deferredChunk) {
        console.error(`Previous query not finished on worker ${index + 1}`);
        throw new Error('Worker is already processing a query');
      }

      if (state?.currentRequest) {
        const queryState = createQueryDebugState?.(index, sql, params);
        state.currentRequest.currentQuery = queryState;
      }

      // Extract query options
      const { chunkSize = 500 } = options ?? {};

      // Prepare for streaming chunks
      deferredChunk = Promise.withResolvers<unknown[] | number>();
      lost = Promise.withResolvers<never>();
      lost.promise.catch(() => {});
      idle = Promise.withResolvers<void>();
      stopRequested = Promise.withResolvers<typeof STOP>();

      // Send query to worker with options
      worker.postMessage({
        type: 'query',
        callId: ++currentCallId,
        sql,
        params,
        options: { chunkSize },
      });

      // Stream chunks until query completes
      while (deferredChunk) {
        const chunk = await Promise.race([
          deferredChunk.promise,
          stopRequested.promise,
          lost.promise,
          deathDeferred.promise,
        ]);
        if (chunk === STOP) break;
        yield chunk as T[] | number;
      }
    } finally {
      // If the consumer left early (break / return / throw) the worker is still
      // stepping rows. Tell it to stop, then wait for the reply it always sends,
      // so the worker is genuinely idle before the lease goes back to the pool.
      // Without this wait, the second half of B1 stands: a released worker still
      // inside sqlite.step().
      if (deferredChunk && !dead) {
        orchestrator.setStatus(
          index,
          WorkerStatuses.ABORTING,
          WorkerStatuses.RUNNING,
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expiry = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SQLiteError(
                  'WORKER_CRASHED',
                  `Worker ${index + 1} did not answer the stop request within ${deps.drainTimeout} ms; presumed dead.`,
                ),
              ),
            deps.drainTimeout,
          );
        });
        try {
          while (deferredChunk) {
            await Promise.race([deferredChunk.promise, expiry]);
          }
        } catch (error) {
          // A timeout is our own verdict and must be acted on. Any other error
          // is the worker reporting a failure while winding down; the caller is
          // already unwinding and surfacing it here would mask their reason.
          if (error instanceof SQLiteError && error.code === 'WORKER_CRASHED') {
            die(error);
          }
        } finally {
          clearTimeout(timer);
        }
      }
      deferredChunk = undefined;
      lost = undefined;
      stopRequested = undefined;
      idle?.resolve();
      idle = undefined;
    }
  };

  // Attach query method to worker
  Object.assign(worker, {
    query,
    /**
     * Ask the worker to stop. Also settles a `next()` already in flight, which
     * is what lets the consumer's queued `return()` reach the generator's
     * finally instead of waiting behind a chunk that may be minutes away.
     */
    interrupt: () => {
      stopRequested?.resolve(STOP);
    },
    quiesce: () => idle?.promise ?? Promise.resolve(),
  });

  // Initialize worker with database file and configuration
  worker.postMessage({
    callId: 0,
    type: 'open',
    file,
    flags: orchestrator.sharedArrayBuffer,
    index,
    vfs,
    pragmas,
  });

  return deferredInit.promise;
};
