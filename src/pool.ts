import { DEFAULT_CREDIT_WINDOW } from './credits';
import { SQLiteError } from './errors';
import type { Logger } from './logger';
import type { SQLiteBuild, SQLiteVFS, WorkerMessageData } from './types';

/**
 * Query execution options forwarded to a pool worker.
 */
export type PoolWorkerQueryOptions = {
  id?: string;
  chunkSize?: number;
  credits?: number;
  debug?: string;
  /**
   * When true, the query's completion does not call `deps.onServed`. Set for
   * the commit-propagation barrier: it is a synthetic probe, not user work, and
   * must not reset the supervisor's restart counter.
   */
  noServed?: boolean;
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
  /** Lifecycle label for the debug surface. Replaces the SAB status byte. */
  status: string;
  /**
   * The commit epoch this connection has absorbed. Starts at -1: a worker
   * opens the file — and reads page 1 — BEFORE it enters the pool, and a
   * commit can land in between. At poolSize 2 that is the nominal startup
   * ordering, not a rare race, so a new worker is always treated as behind and
   * pays exactly one barrier statement in its lifetime.
   */
  seen: number;
  /** The epoch captured when the current lease was granted. */
  epochTarget: number;
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
  /** Posts `close`, awaits the `closed` reply, then the caller must terminate. */
  close: () => Promise<void>;
};

const STOP = Symbol('stop');

/** SQLITE_BUSY and SQLITE_LOCKED — the two ways a lock conflict reports. */
const BUSY_CODES = new Set([5, 6]);

/**
 * Returns a SQLiteError('BUSY', …) when data carries a lock-conflict result
 * code (5 or 6), else undefined. Shared by both the query-error and
 * open-error paths so the BUSY_CODES decision lives in exactly one place.
 */
const busyFromCode = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
}): SQLiteError | undefined =>
  data.sqliteCode !== undefined && BUSY_CODES.has(data.sqliteCode)
    ? new SQLiteError('BUSY', data.message, {
        cause: data.cause,
        sqliteCode: data.sqliteCode,
      })
    : undefined;

/**
 * Mints a typed error only for lock conflicts. Every other SQLite failure
 * keeps today's shape — a plain Error carrying SQLite's message — so no
 * existing consumer's error handling changes.
 */
const workerError = (data: {
  message: string;
  cause?: unknown;
  sqliteCode?: number;
}) => busyFromCode(data) ?? new Error(data.message, { cause: data.cause });

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
  pool: (PoolWorker | undefined)[];
  clientPrefix: string;
  file: string;
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  pragmas?: Record<string, string>;
  onDeath?: (index: number, error: SQLiteError) => void;
  onServed?: (index: number) => void;
  drainTimeout: number;
  createWorkerDebugState?: (index: number, name: string) => any;
  createQueryDebugState?: (
    index: number,
    sql: string,
    params?: unknown[],
  ) => any;
  logger: Logger;
}): Promise<PoolWorker> => {
  const { index, pool, clientPrefix, file, vfs, build, pragmas } = deps;
  const { createWorkerDebugState, createQueryDebugState, logger } = deps;

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
    { index, status: 'NEW', seen: -1, epochTarget: 0 },
  );
  pool[index] = worker;
  logger.info(`worker ${index + 1} created`);

  const state = createWorkerDebugState?.(index, workerName);

  let currentCallId = 0;

  // Deferred promise for streaming query results one chunk at a time
  let deferredChunk: PromiseWithResolvers<unknown[] | number> | undefined;
  // Set by the query generator when options.noServed is true; cleared in
  // case 'done' after (possibly) suppressing onServed, and in the generator's
  // finally so a query that fails before 'done' does not leave it set.
  let suppressServed = false;

  // Deferred promise resolved when the worker replies 'closed'.
  let deferredClose: PromiseWithResolvers<void> | undefined;

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
    worker.status = 'DEAD';
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
    logger.error(`worker ${index + 1} crashed: ${detail}`);
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
    logger.error(`worker ${index + 1} sent an undeserializable message`);
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
    switch (type) {
      case 'ready': {
        if (callId === 0) {
          ready = true;
          worker.status = 'READY';
          if (state) state.initializationTime = Date.now();
          logger.info(`worker ${index + 1} ready`);
          deferredInit.resolve(worker);
        }
        break;
      }
      case 'open-error': {
        if (callId === 0) {
          logger.error(`worker ${index + 1} failed to open: ${data.message}`);
          die(
            busyFromCode(data) ??
              new SQLiteError('WORKER_CRASHED', data.message, {
                cause: data.cause,
              }),
          );
        }
        break;
      }
      case 'closed': {
        if (callId === 0) {
          logger.info(`worker ${index + 1} closed`);
          worker.status = 'CLOSED';
          deferredClose?.resolve();
        }
        break;
      }
      case 'chunk': {
        if (deferredChunk && callId === currentCallId) {
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.firstRowTime ??= Date.now();
          }
          deferredChunk.resolve(data.data);
          deferredChunk = Promise.withResolvers<unknown[] | number>();
        }
        break;
      }
      case 'done': {
        if (deferredChunk && callId === currentCallId) {
          const affected = data.affected;
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.affectedRows = affected;
            state.currentRequest.affectedRows += affected;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          deferredChunk.resolve(affected);
          deferredChunk = undefined;
          if (!suppressServed) deps.onServed?.(index);
          suppressServed = false;
        }
        break;
      }
      case 'error': {
        if (deferredChunk && callId === currentCallId) {
          const error = workerError(data);
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.error = error;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          deferredChunk.reject(error);
          // Do NOT null deferredChunk here. If the generator is suspended at
          // `yield` when the error arrives, nulling it would cause the while
          // loop to exit normally (silent truncation). Leaving the rejected
          // promise in place ensures the generator throws on its next
          // `await Promise.race([deferredChunk.promise, ...])` call, which
          // propagates the error to the consumer. The generator's `finally`
          // clears deferredChunk unconditionally.
          // Attach a no-op handler to suppress unhandled-rejection warnings:
          // the consumer may be suspended (e.g. in sleep()) when the error
          // arrives, and `await Promise.race` only attaches its handler on
          // the next generator resume, which may be a macrotask away.
          deferredChunk.promise.catch(() => {});
        }
        break;
      }
      default: {
        const _unexpected: never = data;
        throw new Error(
          `Unhandled worker message: ${JSON.stringify(_unexpected)}`,
        );
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
      const {
        chunkSize = 500,
        credits = DEFAULT_CREDIT_WINDOW,
        noServed = false,
      } = options ?? {};
      suppressServed = noServed;

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
        options: { chunkSize, credits },
      });
      worker.status = 'RUNNING';

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
        // Spec §3.3: the credit is issued once the CONSUMER has taken the
        // chunk. Crediting on arrival would let the worker run at full speed
        // and pile the chunks up in the message queue, which is the guarantee
        // this whole mechanism exists to make true.
        if (typeof chunk !== 'number') {
          worker.postMessage({ type: 'credit', callId: currentCallId, n: 1 });
        }
      }
    } finally {
      // If the consumer left early (break / return / throw) the worker is still
      // stepping rows. Tell it to stop, then wait for the reply it always sends,
      // so the worker is genuinely idle before the lease goes back to the pool.
      // Without this wait, the second half of B1 stands: a released worker still
      // inside sqlite.step().
      if (deferredChunk && !dead) {
        worker.status = 'ABORTING';
        // Spec §5.1: the worker may be parked waiting for a credit that this
        // unwinding client will never send. The flag above cannot reach it
        // there — only a message can.
        worker.postMessage({ type: 'stop', callId: currentCallId });
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
      // Reset in case the query failed before 'done' arrived — prevents
      // leaking noServed=true into the next query on this worker.
      suppressServed = false;
      worker.status = dead ? 'DEAD' : 'READY';
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
    close: async () => {
      if (!deferredClose) {
        deferredClose = Promise.withResolvers<void>();
        worker.postMessage({ type: 'close', callId: 0 });
      }
      await deferredClose.promise;
    },
  });

  // Initialize worker with database file and configuration
  worker.postMessage({
    callId: 0,
    type: 'open',
    file,
    vfs,
    build,
    pragmas,
  });

  return deferredInit.promise;
};
