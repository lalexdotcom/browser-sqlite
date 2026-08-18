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
};

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

  // Message handler routes responses by callId
  worker.onmessage = ({ data }: MessageEvent<WorkerMessageData>) => {
    const { callId, type } = data;
    if (callId === 0 && type === 'ready') {
      if (state) state.initializationTime = Date.now();
      deferredInit.resolve(worker);
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
        const chunk = await deferredChunk.promise;
        yield chunk as T[] | number;
      }
    } finally {
      // If the consumer left early (break / return / throw) the worker is still
      // stepping rows. Tell it to stop, then wait for the reply it always sends,
      // so the worker is genuinely idle before the lease goes back to the pool.
      // Without this wait, the second half of B1 stands: a released worker still
      // inside sqlite.step().
      if (deferredChunk) {
        orchestrator.setStatus(
          index,
          WorkerStatuses.ABORTING,
          WorkerStatuses.RUNNING,
        );
        try {
          // The message handler replaces deferredChunk on every 'chunk' and clears
          // it on 'done' / 'error', so this drains to completion.
          // NOTE: B2 — if the worker is dead this loop never settles. Per-request
          // timeouts (wave 2) are needed to bound this.
          while (deferredChunk) await deferredChunk.promise;
        } catch {
          // The worker reported an error while winding down. The caller is already
          // unwinding; surfacing it here would mask their reason.
        }
      }
      deferredChunk = undefined;
    }
  };

  // Attach query method to worker
  Object.assign(worker, { query });

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
