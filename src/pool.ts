import { DEFAULT_CREDIT_WINDOW } from './credits';
import { SQLiteError, type SQLiteErrorCode } from './errors';
import type { Logger } from './logger';
import type {
  SQLiteBuild,
  SQLiteVFS,
  WasmLocation,
  WorkerMessageData,
} from './types';

/**
 * Query execution options forwarded to a pool worker.
 */
export type PoolWorkerQueryOptions = {
  chunkSize?: number | undefined;
  credits?: number | undefined;
  timeout?: number | undefined;
  /** Forwarded to the worker so it installs the async progress handler (§4 D2). */
  abortable?: boolean | undefined;
  /**
   * When true, the query's completion does not call `deps.onServed`. Set for
   * the commit-propagation barrier: it is a synthetic probe, not user work, and
   * must not reset the supervisor's restart counter.
   * `createQueryDebugState` is intentionally NOT suppressed: barrier statements
   * still appear in the debug request tree, and a browser test counts them there
   * to prove the barrier stays conditional.
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
export const busyFromCode = (data: {
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
  errorCode?: SQLiteErrorCode;
}) =>
  (data.errorCode
    ? new SQLiteError(data.errorCode, data.message, { cause: data.cause })
    : undefined) ??
  busyFromCode(data) ??
  new Error(data.message, { cause: data.cause });

/**
 * The single `new Worker(new URL(…))` expression in this package.
 *
 * It must stay one literal, in one place: bundlers find the worker by static
 * analysis of exactly this shape, and a second copy would have them emit a
 * second, untransformed worker bundle. `pool.ts:191` records what that cost
 * when the expression was written a second time for an error message.
 */
export const spawnWorker = (name: string): Worker =>
  new Worker(
    /* webpackChunkName: "browser-sqlite" */ new URL(
      './worker/worker.js',
      import.meta.url,
    ),
    { name, type: 'module' },
  );

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
  clientName: string;
  file: string;
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  /** Already resolved and absolute; relayed to the worker, never read here. */
  wasm?: WasmLocation | undefined;
  pragmas?: Record<string, string> | undefined;
  statementCacheSize?: number | undefined;
  statementCacheBytes?: number | undefined;
  onDeath?: (index: number, error: SQLiteError) => void;
  onServed?: (index: number) => void;
  drainTimeout: number;
  createWorkerDebugState?: ((index: number, name: string) => any) | undefined;
  createQueryDebugState?:
    | ((index: number, sql: string, params?: unknown[]) => any)
    | undefined;
  logger: Logger;
  abortSlots?: SharedArrayBuffer | undefined;
}): Promise<PoolWorker> => {
  const {
    index,
    pool,
    clientName,
    file,
    vfs,
    build,
    wasm,
    pragmas,
    statementCacheSize,
    statementCacheBytes,
  } = deps;
  const { createWorkerDebugState, createQueryDebugState, logger } = deps;
  const { abortSlots } = deps;

  const deferredInit = Promise.withResolvers<PoolWorker>();

  const workerName = `${clientName} / Worker ${index + 1}`;
  const worker = Object.assign(spawnWorker(workerName) as PoolWorker, {
    index,
    status: 'NEW',
    seen: -1,
    epochTarget: 0,
  });
  pool[index] = worker;
  // A restarted worker inherits this slot, and its callIds restart at 0 — so
  // the predecessor's last abort would fire on the replacement's seventh call.
  // Zeroing here is the whole guard, and it belongs where the worker is born.
  if (abortSlots) new Int32Array(abortSlots)[index] = 0;
  logger.info(`worker ${index + 1} created`);

  const state = createWorkerDebugState?.(index, workerName);

  let currentCallId = 0;

  // Deferred promise for streaming query results one chunk at a time
  let deferredChunk: PromiseWithResolvers<unknown[] | number> | undefined;

  /**
   * Everything the worker has delivered and the generator has not yielded yet.
   *
   * `deferredChunk` is ONE slot, and the credit window puts `credits` chunks in
   * flight (2 by default). While the generator is suspended at its `yield` —
   * which is every moment the consumer is doing something — an arriving chunk
   * used to resolve a promise nobody would ever await, and the generator then
   * waited on the replacement. The chunk was gone: no error, no short read,
   * just fewer rows. Measured 2026-09-04, deterministic on both engines: 501 of
   * 1001 rows for a consumer that awaited a `setTimeout(0)` between chunks, 500
   * of 1001 at `credits: 4`. It reached `stream()` and `chunk()` and no other
   * surface, because `read()`, `first()` and `write()` never hand control back
   * between chunks — which is why four releases shipped with it.
   *
   * So the promise is now only a wake-up signal, and the VALUES live here. A
   * resolution nobody observes costs nothing; a chunk that was never queued
   * cannot be recovered.
   */
  let inbox: (unknown[] | number)[] = [];

  /**
   * Set by `interrupt()`. Without it, a stop arriving while the inbox holds
   * chunks would be outrun by the drain: the loop would keep yielding buffered
   * chunks and never look at `stopRequested` again. A stop must stop.
   */
  let stopped = false;

  /**
   * The transport's failure, captured the moment it happens rather than
   * observed by awaiting.
   *
   * The delivery loop only awaits — and so only sees `lost` or a death — when
   * the inbox runs dry, and against a steady producer it never does: the
   * consumer takes a chunk, the credit brings the next one, and the queue is
   * refilled before the loop looks up. Measured while building this fix: a
   * `messageerror` raised mid-stream went unreported for the whole remaining
   * query, where it used to reject at once. Failing fast on this flag is what
   * keeps the two channels as urgent as they were.
   */
  let failure: unknown;
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
  // unhandled rejection. The sink is also where the delivery loop learns of a
  // death it is not currently awaiting — see `failure`.
  deathDeferred.promise.catch((error) => {
    failure ??= error;
  });

  // Per-query channel for a message that never arrived (onmessageerror). The
  // worker is alive, so the request rejects but the transport stays intact and
  // the generator's finally still stops and drains it.
  let lost: PromiseWithResolvers<never> | undefined;

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
    // Chrome leaves ErrorEvent.filename empty for worker script-load failures,
    // so this is usually absent — measured 2026-08-27, and it is why the
    // fallback below is not simply the worker's own URL.
    //
    // Deliberately NOT `new URL('./worker/worker.js', import.meta.url)`: that
    // expression is an asset reference every bundler follows, and Vite emits a
    // second, untransformed copy of the worker for it — 777 KB whose own
    // `new URL('wa-sqlite.wasm', …)` references dangle, and which nothing ever
    // loads. It existed only so this message could name a URL.
    //
    // A bare `import.meta.url` is not an asset reference, so naming where the
    // client itself was loaded from costs nothing, and it points at the
    // directory the worker should have been emitted beside — which is the
    // thing a consumer actually needs to check.
    const failedUrl = errorEvent.filename;
    logger.error(`worker ${index + 1} crashed: ${detail}`);
    die(
      new SQLiteError(
        'WORKER_CRASHED',
        ready
          ? `Worker ${index + 1} failed: ${detail || 'uncaught error'}`
          : `browser-sqlite could not load its worker${
              failedUrl
                ? ` from ${failedUrl}`
                : `; the client itself was loaded from ${import.meta.url}, and the worker must be emitted beside it`
            }. ` +
              `If the worker URL 404s, your bundler did not emit the worker beside your build output — ` +
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
    const { type } = data;
    switch (type) {
      case 'ready': {
        const { callId } = data;
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
        const { callId } = data;
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
        const { callId } = data;
        if (callId === 0) {
          logger.info(`worker ${index + 1} closed`);
          worker.status = 'CLOSED';
          deferredClose?.resolve();
        }
        break;
      }
      case 'chunk': {
        const { callId } = data;
        if (deferredChunk && callId === currentCallId) {
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.firstRowTime ??= Date.now();
          }
          // Queue first, then wake. The resolution may reach nobody — that is
          // the whole defect the inbox exists for — but the chunk is kept.
          inbox.push(data.data);
          deferredChunk.resolve(data.data);
          deferredChunk = Promise.withResolvers<unknown[] | number>();
        }
        break;
      }
      case 'done': {
        const { callId } = data;
        if (deferredChunk && callId === currentCallId) {
          const affected = data.affected;
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.affectedRows = affected;
            state.currentRequest.currentQuery.prepared = data.prepared;
            state.currentRequest.affectedRows += affected;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          // The affected count is the last thing the generator yields, so it
          // queues behind whatever chunks are still waiting — a `done` that
          // jumped the queue would truncate them.
          inbox.push(affected);
          deferredChunk.resolve(affected);
          deferredChunk = undefined;
          if (!suppressServed) deps.onServed?.(index);
          suppressServed = false;
        }
        break;
      }
      case 'error': {
        const { callId } = data;
        if (deferredChunk && callId === currentCallId) {
          const error = workerError(data);
          if (state?.currentRequest?.currentQuery) {
            state.currentRequest.currentQuery.error = error;
            state.currentRequest.currentQuery.endTime = Date.now();
          }
          deferredChunk.reject(error);
          // Deliberately NOT `failure = error`, which is what a `messageerror`
          // and a death do. Those two mean the transport is broken, so nothing
          // queued behind them can be trusted and the drain stops at once. A
          // query error is the opposite: the worker produced those rows and
          // then failed, so the consumer receives what SQLite actually returned
          // and the error arrives after it. Setting the flag here would
          // suppress rows that exist.
          //
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
      case 'deleted': {
        // A connection worker never deletes; this message belongs to the
        // delete-worker path handled in src/delete.ts and cannot arrive here.
        break;
      }
      case 'not-found': {
        // Same as deleted: only the delete-worker path (src/delete.ts) receives
        // this message. A connection worker never sends it.
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
        timeout,
        abortable,
      } = options ?? {};
      suppressServed = noServed;

      // Prepare for streaming chunks
      inbox = [];
      stopped = false;
      // A death is terminal for this worker, so its failure outlives the query
      // that observed it; a transport failure belongs to one query only.
      if (!dead) failure = undefined;
      deferredChunk = Promise.withResolvers<unknown[] | number>();
      lost = Promise.withResolvers<never>();
      lost.promise.catch((error) => {
        failure ??= error;
      });
      idle = Promise.withResolvers<void>();
      stopRequested = Promise.withResolvers<typeof STOP>();

      // Send query to worker with options
      worker.postMessage({
        type: 'query',
        callId: ++currentCallId,
        sql,
        params,
        options: { chunkSize, credits, timeout, abortable },
      });
      worker.status = 'RUNNING';

      // Stream chunks until the query completes AND the inbox is empty. The
      // second half is not belt-and-braces: `done` clears `deferredChunk`, so a
      // loop that watched only the flag would exit on the last message and
      // drop whatever was still queued behind it.
      while (deferredChunk || inbox.length > 0) {
        if (inbox.length === 0) {
          // Nothing queued: wait to be woken. The resolved VALUE is ignored —
          // it is read from the inbox on the next turn, because a wake and a
          // delivery are no longer the same event.
          const waiting = deferredChunk;
          if (!waiting) break;
          const outcome = await Promise.race([
            waiting.promise,
            stopRequested.promise,
            lost.promise,
            deathDeferred.promise,
          ]);
          if (outcome === STOP) break;
          continue;
        }
        // A stop that arrives with chunks still queued must win: otherwise the
        // drain outruns it and the consumer keeps receiving rows it abandoned.
        if (stopped) break;
        // Same reasoning for the two failure channels, which the loop is no
        // longer awaiting while it has something to deliver.
        if (failure !== undefined) throw failure;
        const chunk = inbox.shift() as T[] | number;
        yield chunk;
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
      // Chunks the consumer abandoned. Left in place they would be yielded to
      // the NEXT query on this worker, which is the same defect wearing the
      // opposite sign: rows delivered to a caller that never asked for them.
      inbox = [];
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
      stopped = true;
      stopRequested?.resolve(STOP);
      // The slot reaches a worker that is computing inside step() and reads no
      // messages until it yields — which the sync build never does. The message
      // that wakes a worker parked on a credit is sent by the query generator's
      // finally block; interrupt() owns only the slot write.
      if (abortSlots)
        Atomics.store(new Int32Array(abortSlots), index, currentCallId);
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
    wasm,
    pragmas,
    statementCacheSize,
    statementCacheBytes,
    abortSlots,
    abortIndex: abortSlots ? index : undefined,
  });

  return deferredInit.promise;
};
