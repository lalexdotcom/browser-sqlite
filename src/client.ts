import type { OptionsWithSignal, SQLiteChunkOptions, SQLiteDB } from './api';
import { createBulk } from './bulk';
import {
  describeMissing,
  detectFeatures,
  missingFeature,
} from './capabilities';
import { createClientDebug } from './debug';
import { advanceSeen, BARRIER_SQL, epochsFor } from './epochs';
import { SQLiteError } from './errors';
import { createLocks, sharesStorage, writeLockName } from './locks';
import { createLogger } from './logger';
import { createPoolWorker, type PoolWorker } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
  makeAbortRace,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import {
  createScheduler,
  type InternalSQLiteClientOptions,
  type WriterPolicy,
} from './scheduler';
import { createSupervisor } from './supervisor';
import { createTransaction } from './transaction';
import {
  defaultBuildFor,
  RECOMMENDED_VFS,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
} from './types';
import {
  assertReadable,
  mergeSignals,
  normalizeDatabaseFile,
  renderPragmas,
  resolveWasmLocation,
} from './utils';

/**
 * SQLite client for browser environments using a pool of Web Workers.
 *
 * Features:
 * - Worker pool management for concurrent SQLite operations
 * - Read/write query differentiation with exclusive write access
 * - Streaming results support for large datasets
 * - Transaction support with rollback capability
 */

const DEFAULT_POOL_SIZE = 2;

/**
 * Statements retained per worker. Not a consumer option (spec §3.2): the
 * value is declared here rather than in the worker so that exposing it later
 * is one options line, not a move.
 */
const DEFAULT_STATEMENT_CACHE_SIZE = 32;

/**
 * Configuration options for creating a SQLite client.
 */
export type CreateSQLiteClientOptions = {
  /**
   * Database file name within the OPFS origin private file system.
   * Each unique name maps to a distinct SQLite database file.
   * @defaultValue `"SQLite"` prefix + auto-incremented client index
   */
  name?: string;

  /**
   * Number of Web Workers spawned in the pool at initialization.
   * A larger pool allows more concurrent read operations but increases
   * memory consumption and OPFS file handle usage.
   * Must be `1` when using `AccessHandlePoolVFS` — any larger value throws at construction time.
   * @defaultValue `2`
   */
  poolSize?: number;

  /**
   * Which VFS stores the database. Required: a VFS decides *where* the bytes
   * live, and a database written through one VFS is not visible through
   * another. See the README's VFS Selection guide.
   */
  vfs: SQLiteVFS;
  /**
   * Which wa-sqlite WebAssembly build to load. Defaults to the first entry of
   * `VFS_CAPABILITIES[vfs]` — `sync` where the VFS supports it, since it is both the
   * fastest and the most portable, otherwise `async`. `jspi` needs engine
   * support; see the README's Builds section for versions.
   *
   * @throws at construction when the build is not one the chosen VFS supports.
   */
  build?: SQLiteBuild;

  /**
   * Where the workers fetch their `.wasm` from. **An escape hatch, not a
   * setting**: omit it and resolution is exactly what it was before this
   * option existed — the file is taken from beside `worker.js`, which is where
   * the package ships it and where every bundler emits it.
   *
   * Reach for it only when the `.wasm` have been separated from `worker.js`:
   * assets moved by hand with no bundler, or a build whose emitted URL is
   * wrong at runtime.
   *
   * A **string is a directory**, resolved against the page — relative
   * (`'wasm/'`), absolute (`'/static/wasm'`) or a full URL. A missing trailing
   * slash is added. The file name comes from wa-sqlite itself, so one base
   * serves whichever `build` is loaded.
   *
   * A **callback names one file** and receives the resolved `build`, for a
   * bundler-emitted asset whose name carries a content hash:
   * ```ts
   * import wasmUrl from 'browser-sqlite/dist/worker/wa-sqlite.wasm?url';
   * createSQLiteClient('app.db', { vfs, wasmUrl: () => wasmUrl });
   * ```
   * It is called once, at construction, and its answer is reused by every
   * worker and every restart.
   *
   * Serving the `.wasm` from another origin has two requirements beyond this
   * option, both enforced by the browser: the response needs CORS
   * (`Access-Control-Allow-Origin`), since the glue fetches it, and it must
   * carry `Content-Type: application/wasm` for streaming compilation.
   *
   * @throws at construction when the value cannot be parsed as a URL.
   */
  wasmUrl?: string | ((build: SQLiteBuild) => string);

  /**
   * SQLite PRAGMAs applied to each worker's database connection on open.
   * Keys are PRAGMA names, values are their string representations.
   * Example: `{ journal_mode: 'WAL', synchronous: 'NORMAL' }`.
   * If omitted, no PRAGMAs are applied beyond SQLite defaults.
   */
  pragmas?: Record<string, string>;

  /**
   * How many times a worker slot may be restarted after it has died.
   * A slot that never reached readiness is never restarted — an initial
   * failure is deterministic, and restarting only delays the diagnostic.
   * The counter resets once the replacement has actually served a request.
   * @defaultValue `1`
   */
  maxWorkerRestarts?: number;

  /**
   * Milliseconds a worker has to post `ready` after its `open` message is sent.
   * On expiry the slot is failed immediately — the most common cause is a
   * database held under an exclusive lock by another tab or client.
   * @defaultValue `30_000`
   */
  openTimeout?: number;

  /**
   * Milliseconds the drain loop (in the query generator's `finally`) may run
   * before the worker is presumed dead and the crash path is invoked.
   * @defaultValue `60_000`
   */
  drainTimeout?: number;

  /**
   * Turns on the introspection subsystem exposed as `db.debug`, and the
   * lifecycle log. A string is used as the log prefix; `true` falls back to the
   * client prefix (`"<name> <index>"`), which already names the workers.
   *
   * @defaultValue undefined — no collection, no output, `db.debug` undefined.
   */
  debug?: string | boolean;

  /**
   * Called whenever a worker slot is permanently lost. Receives the slot index,
   * the number of workers still alive after the loss, the requested pool size,
   * and the error that killed the slot.
   *
   * Guaranteed to be called **before** the client is failed when the last slot
   * is lost. Wrapped in try/catch — a throwing callback is reported through
   * `logger.always.warn` and does not break the pool.
   *
   * @defaultValue undefined
   */
  onWorkerLost?: (event: WorkerLostEvent) => void;
};

/**
 * What `onWorkerLost` receives. Named and exported rather than inlined in the
 * option: a consumer whose handler is a standalone function needs to be able
 * to type its parameter.
 */
export type WorkerLostEvent = {
  /** Zero-based index of the lost slot. */
  index: number;
  /** Number of workers still alive after this loss. */
  live: number;
  /** The requested pool size (`poolSize` option). */
  size: number;
  /** The error that killed the worker. */
  cause: SQLiteError;
};

let clientCount = 0;

/**
 * Creates a SQLite client backed by a pool of Web Workers, each running
 * a wa-sqlite instance in a dedicated thread.
 *
 * @remarks
 * **Browser requirements:** This client uses OPFS through Web Workers; no
 * special HTTP headers are required and cross-origin isolation is not needed.
 * The default `build` needs no browser opt-in; only `build: 'jspi'` does, and
 * JSPI is Chromium-only — an unrelated constraint, not a header requirement.
 *
 * **Worker pool side effect:** Calling this function immediately spawns
 * `poolSize` Web Worker threads and begins asynchronous database
 * initialization. Workers become queryable once they emit a `ready` message.
 *
 * @param file - SQLite database file name within the OPFS origin.
 *   Each distinct name corresponds to a separate database file.
 * @param clientOptions - Pool and VFS configuration. Required: `vfs` has no
 *   default, because a VFS decides where the database is written.
 *   See {@link CreateSQLiteClientOptions} for field defaults.
 * @returns A {@link SQLiteDB} object providing `read`, `write`, `chunk`,
 *   `stream`, `first`, `transaction`, `bulkWrite`, `output`, and `close` methods.
 *
 * @throws {SQLiteError} With code `INVALID_OPTION` when `build` is not one of
 *   the builds the chosen `vfs` supports. The message names the supported
 *   builds; the pairing is declared once, in `VFS_CAPABILITIES`.
 * @throws {SQLiteError} With code `INVALID_OPTION` when `poolSize` exceeds the
 *   `maxPoolSize` the chosen `vfs` declares. The message names the cap and the
 *   reason for it; both come from `VFS_CAPABILITIES`.
 *
 * @example
 * ```typescript
 * import { createSQLiteClient } from 'browser-sqlite';
 *
 * const db = createSQLiteClient('myapp.sqlite', {
 *   poolSize: 3,
 *   vfs: 'OPFSAdaptiveVFS',
 *   pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL' },
 * });
 *
 * const users = await db.read<{ id: number; name: string }>(
 *   'SELECT id, name FROM users WHERE active = ?',
 *   [1],
 * );
 * ```
 */
export const createSQLiteClient = (
  file: string,
  clientOptions: CreateSQLiteClientOptions,
) => {
  // One definition of database identity for the workers, the VFS, the epoch
  // registry, every lock name and the returned `db.debug.file`.
  const dbFile = normalizeDatabaseFile(file);

  // FIRST, before anything reads the options. `clientOptions` is required in
  // the type, but a JavaScript caller can still omit it entirely — and then
  // every access below would throw a bare TypeError naming nothing. The `?.`
  // here is the only one left in this function, and it is load-bearing: it is
  // what turns a missing argument into the error that says what to pass.
  //
  // Required, and thrown for rather than defaulted: a moving default would
  // leave a consumer reading an empty database while their bytes sat in a VFS
  // nothing queries.
  if (!clientOptions?.vfs) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `vfs is required. ${RECOMMENDED_VFS} is the recommended universal choice and was the previous default — pass it to keep reading a database created before this version. Compare VFS in the README's VFS Selection guide, and measure your own targets at https://lalexdotcom.github.io/browser-sqlite/`,
    );
  }

  const clientIndex = ++clientCount;

  const clientPrefix = `${clientOptions.name ?? 'SQLite'} ${clientIndex}`;

  const poolSize = clientOptions.poolSize ?? DEFAULT_POOL_SIZE;
  const pool: (PoolWorker | undefined)[] = [];

  const vfs = clientOptions.vfs;
  const build = clientOptions.build ?? defaultBuildFor(vfs);

  const capability = VFS_CAPABILITIES[vfs];

  // Synchronous: an unsupported combination must fail here and name itself,
  // not surface later as an opaque open-error from a worker that could not
  // instantiate its module.
  if (!(capability.builds as readonly SQLiteBuild[]).includes(build)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} cannot run on the '${build}' build. Supported: ${capability.builds.join(', ')}.`,
    );
  }

  // Resolved once, here, and reused by every worker in the pool and by every
  // restart — a callback must not be re-entered per slot. Undefined when the
  // option was not given, which is what leaves the worker's resolution alone.
  const wasm = resolveWasmLocation(clientOptions.wasmUrl, build, location.href);

  if (capability.maxPoolSize !== null && poolSize > capability.maxPoolSize) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} does not support pool sizes greater than ${capability.maxPoolSize}: ${capability.poolLimitReason}. Set poolSize: ${capability.maxPoolSize}.`,
    );
  }

  // The engine, not the declaration. Without this the mismatch surfaces later
  // as an opaque open-error from a worker that could not instantiate wasm.
  const absent = missingFeature(vfs, build, detectFeatures());
  if (absent) {
    throw new SQLiteError(
      'INVALID_OPTION',
      describeMissing(vfs, build, absent),
    );
  }

  // Fail at construction, not inside the first unrelated query.
  if (clientOptions.pragmas) renderPragmas(clientOptions.pragmas);

  // TEST-ONLY, UNSUPPORTED. Read once here, validated, and converted to a
  // typed internal value so no `any` travels further. Absent from the public
  // options type on purpose — see InternalSQLiteClientOptions in scheduler.ts.
  const testWriterPolicy = (clientOptions as InternalSQLiteClientOptions)
    .__unsafeTestWriterPolicy;
  const writerPolicy: WriterPolicy | undefined =
    typeof testWriterPolicy === 'function' ? testWriterPolicy : undefined;

  // ---------------------------------------------------------------------------
  // Startup state: the deferred first-settle verdict
  //
  // While inStartup is true the gate is still closed and handleDeath skips
  // supervisor entirely. The verdict (fast-fail or single retry round) fires
  // from the scheduler's onFirstSettle callback.  inStartup is cleared in
  // onGateOpen (which fires after the retry round, or immediately when all
  // slots opened without failure).
  // ---------------------------------------------------------------------------
  let inStartup = true;
  let startupFirstError: SQLiteError | undefined;
  // Every startup death is recorded here keyed by slot index, and removed in
  // spawn's .then() when the slot becomes ready (retry round success). What
  // remains when the gate opens are the slots that permanently failed.
  const startupLosses = new Map<number, SQLiteError>();

  /**
   * Creates a new pool worker and adds it to the pool.
   * Sets up message routing via callId for query responses.
   */
  const scheduler = createScheduler<PoolWorker>(
    (() => {
      // onFirstSettle and onGateOpen are callbacks that fire asynchronously
      // (after all const declarations in this scope have been initialised), so
      // references to spawn / failClient / supervisor / emitWorkerLost are
      // safe even though those names appear later in the source.
      const onFirstSettle = (result: {
        openedCount: number;
        failedIndices: number[];
      }) => {
        if (result.openedCount === 0) {
          // Total startup failure: every slot failed to open. No retry —
          // when nothing opened the config is wrong and a retry only delays
          // the error.
          //
          // Emit loss for every failed slot before failing the client — the
          // contract requires the callback to fire before the client is failed.
          // The supervisor is not consulted here: no R1 restart or liveness
          // logic applies when nothing opened; the failure is total and
          // permanent.
          //
          // startupFirstError is always set when openedCount === 0 because
          // every settled-failed slot goes through handleDeath, which sets it.
          // The fallback is unreachable but satisfies the linter.
          inStartup = false;
          for (const [index, error] of startupLosses) {
            emitWorkerLost(index, error);
          }
          startupLosses.clear();
          failClient(
            startupFirstError ??
              new SQLiteError(
                'WORKER_CRASHED',
                'All workers failed to open the database.',
              ),
          );
          return;
        }
        // One retry round, hardcoded.  The count is not an option yet because:
        // the startup contention that motivates this path (exclusive OPFS
        // handle rotating between workers on Firefox) is a transient, bounded
        // race, not a persistent fault.  One round is enough to resolve it.
        // Exposing a knob before we have evidence the default is wrong would
        // make the option permanent to remove.
        for (const index of result.failedIndices) {
          scheduler.rearmSlot(index);
          spawn(index);
        }
        // If failedIndices is empty the gate opens immediately (no re-arming).
        // If not, it stays closed until retry slots settle.
      };

      const onGateOpen = () => {
        inStartup = false;
        // Report all startup deaths to the supervisor first so liveCount() is
        // correct for post-startup R1 decisions, and collect verdicts.
        let failClientError: SQLiteError | undefined;
        for (const [index, error] of startupLosses) {
          // 'lost', not 'died': the retry round is capped at one, so these
          // slots are not coming back and the consumer is about to be told so.
          // 'died' would return 'restart' for a slot that had opened, leave it
          // revivable, and spend a restart that never happens — the supervisor
          // would then disagree with the `onWorkerLost` we emit below.
          const verdict = supervisor.report(index, 'lost');
          // Honour a 'fail-client' verdict from the supervisor.
          if (verdict === 'fail-client') failClientError ??= error;
        }
        // Emit all losses BEFORE possibly failing the client — the contract
        // requires the callback to fire before the client is failed.
        for (const [index, error] of startupLosses) {
          emitWorkerLost(index, error);
        }
        startupLosses.clear();
        // Also fail the client when the pool is empty even if no verdict was
        // 'fail-client'. This handles the case where supervisor returns
        // 'restart' for an everReady slot (e.g., slot 0 opened in round 1 and
        // died during the retry round) while slot 1's verdict depends on
        // iteration order — the pool check is order-independent.
        if (
          failClientError !== undefined ||
          pool.filter(Boolean).length === 0
        ) {
          failClient(
            failClientError ??
              startupFirstError ??
              new SQLiteError(
                'WORKER_CRASHED',
                'All workers failed to open the database.',
              ),
          );
        }
      };

      return writerPolicy
        ? {
            canDesignateWriter: writerPolicy,
            poolSize,
            onFirstSettle,
            onGateOpen,
          }
        : { poolSize, onFirstSettle, onGateOpen };
    })(),
  );

  const debugOption = clientOptions.debug;

  const debugPrefix =
    typeof debugOption === 'string' ? debugOption : clientPrefix;

  const logger = createLogger(debugPrefix, !!debugOption);

  const clientDebug = debugOption
    ? createClientDebug(
        dbFile,
        pool,
        {
          vfs,
          pragmas: clientOptions.pragmas ?? {},
          name: clientOptions.name ?? 'SQLite',
        },
        () => scheduler.stats(),
      )
    : undefined;

  const debug = clientDebug?.state;

  const locks = createLocks();
  /**
   * Undefined on the memory VFS, where two clients on one name are two
   * independent databases — see `sharesStorage`.
   */
  const writeLock = sharesStorage(vfs) ? writeLockName(vfs, dbFile) : undefined;
  /**
   * The in-flight epoch publication, awaited before the write lock is handed
   * back. Task 6 assigns it; until then it is always already settled.
   */
  // biome-ignore lint/style/useConst: Task 6 assigns this after its first epoch publication.
  let publishing: Promise<unknown> = Promise.resolve();
  /**
   * Aborted by `close()` the moment closing begins. Merged into every pending
   * write-lock request so that close() cancels writes still waiting on the
   * origin-wide lock. A lock already granted is unaffected — per the Web Locks
   * specification the signal cancels a pending request only.
   */
  const closeAbort = new AbortController();

  const epochs = epochsFor(vfs, dbFile, locks);

  /**
   * The barrier. Runs on a leased worker, so nothing can interleave a
   * statement between it and the query the lease was taken for — the lease
   * supplies the atomicity of the pair for free.
   *
   * `target` is captured BEFORE the statement: if another client commits while
   * it is in flight, this connection did not observe that commit and must not
   * be credited with it.
   */
  const applyBarrier = async (worker: PoolWorker) => {
    const target = epochs.current();
    worker.epochTarget = target;
    if (worker.seen >= target) return;
    // Drained, not just dispatched: it is the opening AND closing of the read
    // transaction that refreshes page 1. noServed: true prevents the barrier
    // from resetting the supervisor's restart counter — it is a synthetic probe,
    // not user work.
    const barrierIter = worker.query(BARRIER_SQL, undefined, {
      noServed: true,
    });
    while (!(await barrierIter.next()).done) {
      /* discard rows */
    }
    // Only on success — a failed barrier leaves the worker marked behind so
    // the next attempt re-posts it.
    worker.seen = target;
  };

  /** Records a commit. Called after the write, before its promise resolves. */
  const afterWrite = (worker: PoolWorker) => {
    worker.seen = advanceSeen(worker.seen, worker.epochTarget, epochs.bump());
  };

  /**
   * Debug-stamps the acquisition with request timing. Extracted from
   * acquireInstrumented so the barrier wrapper can cover both paths uniformly.
   */
  const acquireWithDebug = async (
    kind: 'read' | 'write',
    signal?: AbortSignal,
  ) => {
    // Called only when clientDebug is set — cast to NonNullable to avoid the
    // forbidden non-null assertion operator while preserving the correct type.
    const request = (
      clientDebug as NonNullable<typeof clientDebug>
    ).createRequestDebugState();
    const lease = await scheduler.acquire(kind, signal);
    request.assign(lease.worker.index);

    return {
      worker: lease.worker,
      release: () => {
        request.state.releaseTime = Date.now();
        lease.release();
      },
    };
  };

  /**
   * The single owner of the request level of the debug tree.
   *
   * There are six acquisition sites; instrumenting each is six chances to
   * miss one. This wrapper stamps `acquireTime` (through `assign`) and
   * `releaseTime`, and is a pass-through when debug is off. Nothing outside it
   * calls `scheduler.acquire`. The barrier runs on the acquired lease before
   * the caller sees it — the lease atomically covers the barrier statement and
   * the real query together.
   */
  const acquireInstrumented = async (
    kind: 'read' | 'write',
    signal?: AbortSignal,
  ) => {
    // Lock BEFORE the lease, never after. The reverse holds a pool worker
    // while blocked on a cross-tab lock: at poolSize 2, two queued writes
    // would starve this tab's own reads behind a lock another tab holds.
    //
    // The wait is abortable by the caller's signal AND by the internal close
    // signal. The HOLD is not aborted — a lock released while SQLite still
    // holds its own would lie. Per the Web Locks spec, the signal cancels a
    // pending request only; once granted the hold is irrevocable from here.
    let releaseWrite: (() => void) | undefined;
    if (kind === 'write' && writeLock) {
      // Merge the caller's signal with the close-abort signal. mergeSignals is
      // used rather than AbortSignal.any to stay within the library's browser
      // floor (Chrome 92 / Firefox 95 / Safari 15.4).
      const { signal: lockSignal, release: releaseMerge } = mergeSignals(
        signal,
        closeAbort.signal,
      );
      let webRelease: () => void;
      try {
        webRelease = await locks.hold(
          writeLock,
          lockSignal ? { signal: lockSignal } : undefined,
        );
      } catch (error) {
        releaseMerge();
        // Surface CLIENT_CLOSED when the close signal caused the abort.
        // If the caller's signal fired first, rethrow the original error.
        if (closeAbort.signal.aborted) throw closeAbort.signal.reason;
        throw error;
      }
      releaseMerge();
      releaseWrite = webRelease;
    }

    let lease: Awaited<ReturnType<typeof scheduler.acquire>>;
    try {
      lease = clientDebug
        ? await acquireWithDebug(kind, signal)
        : await scheduler.acquire(kind, signal);
    } catch (error) {
      releaseWrite?.();
      throw error;
    }

    try {
      // Raced, not merely passed a signal. `applyBarrier` drains a real query
      // on the worker, and `PoolWorkerQueryOptions` carries no signal — so on
      // a worker that never answers, that loop is unbounded and every method
      // goes through it. Firefox 154 stopped here, on OPFSCoopSyncVFS, after
      // the two earlier abort paths were closed.
      //
      // This is the second and last phase of a call that was not already
      // abortable: `scheduler.acquire` now honours the signal while queued,
      // and the query phase has honoured it since wave 1. Guarding here rather
      // than at each public method is what makes that complete — an await
      // added to this function later is covered without being remembered.
      //
      // The race abandons the WAIT, not the WORK: the barrier statement runs
      // on. The catch below releases through `quiesce()`, which returns the
      // worker only once it is actually idle, so nothing is re-lent mid-flight.
      const { aborted, teardown } = makeAbortRace(signal);
      try {
        const barrier = applyBarrier(lease.worker);
        await (aborted ? Promise.race([barrier, aborted]) : barrier);
      } finally {
        teardown();
      }
    } catch (error) {
      // The caller never received the lease, so its try/finally cannot return
      // the worker. Release on the same path a normal caller would.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
      releaseWrite?.();
      throw error;
    }

    if (!releaseWrite) return lease;

    // The write lock outlives the worker: it is released once the lease is
    // released AND the epoch this write published has been taken, so no other
    // tab can acquire the lock, run its query(), and miss our marker.
    let handedBack = false;
    return {
      ...lease,
      release: () => {
        lease.release();
        if (handedBack) return;
        handedBack = true;
        void publishing.then(releaseWrite, releaseWrite);
      },
    };
  };

  /**
   * Executes a read query and returns all results.
   * Automatically acquires and releases a worker from the pool.
   *
   * @remarks
   * **Read-your-own-writes is guaranteed within the tab.** Any read issued after a
   * write resolves — from that client or from any other client in the same tab on
   * the same database — observes it, regardless of pool size. It is not guaranteed
   * across tabs.
   */
  const read = async <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: OptionsWithSignal,
  ) => {
    assertReadable(sql, 'read');
    const lease = await acquireInstrumented('read', options?.signal);
    try {
      return await readWorker<T>(lease.worker, sql, params, options);
    } finally {
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };

  /**
   * Executes a query and yields result rows in chunks.
   * The single abort-aware primitive — all other read paths derive from this.
   *
   * @remarks
   * **Worker freshness.** See the `read()` remarks — read-your-own-writes is
   * guaranteed within the tab, not across tabs.
   */
  const chunk = async function* <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[], options?: SQLiteChunkOptions) {
    assertReadable(sql, 'chunk');
    const lease = await acquireInstrumented('read', options?.signal);
    try {
      yield* chunkWorker<T>(lease.worker, sql, params, options);
    } finally {
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };

  /**
   * Executes a query and streams individual rows (flattened from chunks).
   *
   * @remarks
   * **Worker freshness.** See the `read()` remarks — read-your-own-writes is
   * guaranteed within the tab, not across tabs.
   */
  const stream = async function* <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[], options?: SQLiteChunkOptions) {
    assertReadable(sql, 'stream');
    const lease = await acquireInstrumented('read', options?.signal);
    try {
      yield* streamRows<T>(lease.worker, sql, params, options);
    } finally {
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };

  /**
   * Executes a write query and returns results with affected row count.
   * Automatically acquires and releases a worker from the pool.
   */
  const write = async <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: OptionsWithSignal,
  ) => {
    const lease = await acquireInstrumented('write', options?.signal);
    try {
      return await writeWorker<T>(lease.worker, sql, params, options);
    } finally {
      // Before the void: release is asynchronous, so write() resolves first. A
      // read chained on this promise would otherwise acquire before the
      // increment, observe the old epoch, and skip the barrier — the exact bug
      // being fixed. In `finally`, so a failed write bumps too: that costs a
      // barrier statement, never a wrong read.
      afterWrite(lease.worker);
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };

  /**
   * Executes a query and returns only the first row.
   * Breaks after the first chunk — no internal AbortController needed.
   *
   * @remarks
   * **Worker freshness.** See the `read()` remarks — read-your-own-writes is
   * guaranteed within the tab, not across tabs.
   */
  const first = async <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: OptionsWithSignal,
  ) => {
    assertReadable(sql, 'first');
    const lease = await acquireInstrumented('read', options?.signal);
    try {
      return await firstWorker<T>(lease.worker, sql, params, options);
    } finally {
      // The lease returns when the worker confirms it is idle, not when the
      // caller leaves: a worker still inside step() must not be re-lent, and
      // the caller must not wait for it.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
    }
  };

  const bulkFor = createBulk({ file: dbFile, locks: createLocks(), logger });

  const transaction = createTransaction({
    scheduler: { ...scheduler, acquire: acquireInstrumented },
    afterWrite,
    // Wrapped, not passed by reference: handleDeath is declared further down
    // and would be in its temporal dead zone here.
    onPoisoned: (index, error) => handleDeath(index, error),
    bulkFor,
  });

  const { bulkWrite, output } = bulkFor({ read, write, transaction });

  /** Bounds any settlement that depends on a worker answering. */
  const bounded = async (promise: Promise<unknown>, ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  let closing: Promise<void> | undefined;

  /**
   * Drains in-flight work, rejects queued work, closes each database
   * connection, then terminates all workers. Bounded by `drainTimeout`.
   * A second call returns the same promise object — runs exactly once.
   */
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      logger.info('client closing');
      const closingError = new SQLiteError(
        'CLIENT_CLOSED',
        'The SQLite client has been closed.',
      );
      // Cancel every pending write-lock request (those still waiting for the
      // browser's lock manager to grant the lock). Writes that already hold
      // the lock are past the lock phase and unaffected — per the Web Locks
      // spec the signal cancels a pending request only. Those writes hold a
      // scheduler lease and are drained by shutdown() below.
      closeAbort.abort(closingError);
      // Shutting the front door: queued scheduler waiters reject at once and
      // no new leases can be taken while in-flight work drains.
      const draining = scheduler.shutdown(closingError);
      // A transaction's lease is held by user code, so this wait is bounded like
      // the rest: a callback that never returns must not make close() hang.
      await bounded(draining, drainTimeout);
      await Promise.all(
        pool.map(async (worker) => {
          if (!worker) return;
          await bounded(worker.close(), drainTimeout);
          worker.terminate();
        }),
      );
      pool.length = 0;
    })();
    return closing;
  };

  const openTimeout = clientOptions.openTimeout ?? 30_000;
  const drainTimeout = clientOptions.drainTimeout ?? 60_000;

  const supervisor = createSupervisor({
    size: poolSize,
    maxWorkerRestarts: clientOptions.maxWorkerRestarts,
  });

  let fatal: SQLiteError | undefined;

  const failClient = (error: SQLiteError) => {
    fatal ??= error;
    void scheduler.shutdown(fatal);
    for (const dying of pool) dying?.terminate();
  };

  const spawn = (index: number) => {
    // The slot holds a worker again from here — not from `ready`. Without this,
    // a restarted slot stays marked dead and the replacement's own death is
    // taken for a duplicate signal about the worker it replaced: no decision
    // comes back, nothing restarts, nothing fails, and the pool is empty and
    // silent for the rest of the client's life.
    supervisor.report(index, 'spawned');
    const timer = setTimeout(() => {
      handleDeath(
        index,
        new SQLiteError(
          'TIMEOUT',
          `Worker ${index + 1} did not become ready within ${openTimeout} ms. ` +
            `The database may be held under an exclusive lock by another tab or another client.`,
        ),
      );
    }, openTimeout);

    void createPoolWorker({
      index,
      pool,
      clientPrefix,
      file: dbFile,
      vfs,
      build,
      wasm,
      pragmas: clientOptions.pragmas,
      statementCacheSize: DEFAULT_STATEMENT_CACHE_SIZE,
      onDeath: handleDeath,
      onServed: (served) => {
        supervisor.report(served, 'served');
      },
      drainTimeout,
      createWorkerDebugState: clientDebug?.createWorkerDebugState,
      createQueryDebugState: clientDebug?.createQueryDebugState,
      logger,
    })
      .then((worker) => {
        supervisor.report(index, 'ready');
        // If this slot was recorded in startupLosses (it failed in a prior
        // round and is now recovering in the retry), remove the record so it
        // is not reported as permanently lost in onGateOpen.
        startupLosses.delete(index);
        scheduler.add(worker);
      })
      .catch(() => {
        // The rejection is the death already reported through onDeath.
      })
      .finally(() => clearTimeout(timer));
  };

  /**
   * Permanently loses a worker slot: logs the loss via the always-on channel
   * and calls the onWorkerLost callback (if provided). Must be called BEFORE
   * failClient so the callback sees the event before the client is shut down.
   */
  const emitWorkerLost = (index: number, error: SQLiteError) => {
    // pool[index] is already undefined here (cleared by handleDeath or startup).
    const live = pool.filter(Boolean).length;
    logger.always.warn(
      `worker ${index + 1} lost; pool is now ${live} of ${poolSize}`,
    );
    const cb = clientOptions.onWorkerLost;
    if (cb) {
      try {
        cb({ index, live, size: poolSize, cause: error });
      } catch (cbError) {
        logger.always.warn(
          `onWorkerLost callback threw: ${cbError instanceof Error ? cbError.message : String(cbError)}`,
        );
      }
    }
  };

  const handleDeath = (index: number, error: SQLiteError) => {
    // Snapshot inStartup BEFORE scheduler.remove() may trigger onFirstSettle or
    // onGateOpen (both of which can change inStartup synchronously).
    const wasInStartup = inStartup;

    if (wasInStartup) {
      // During startup (gate still closed), defer the verdict to onFirstSettle.
      // A slot that fails before all others have settled must not be restarted
      // or marked lost immediately: we cannot yet distinguish "only this slot
      // is broken" from "contention during startup resolved itself for others".
      //
      // Set startupFirstError BEFORE scheduler.remove() so that onFirstSettle
      // (which fires synchronously inside remove()) reads the correct error.
      startupFirstError ??= error;
      // Record every startup death — not only retry-slot deaths (defect 1).
      // The entry is removed in spawn's .then() when the slot becomes ready,
      // so only permanently lost slots remain by the time onGateOpen fires.
      startupLosses.set(index, error);
    }

    // Terminate and clear BEFORE scheduler.remove() so that emitWorkerLost
    // (called from onGateOpen / post-startup path, both inside or after remove)
    // computes the correct live count from pool.
    pool[index]?.terminate();
    pool[index] = undefined;

    scheduler.remove(index); // may synchronously trigger onFirstSettle/onGateOpen

    if (wasInStartup) return; // startup: handled entirely by the scheduler callbacks

    // Post-startup: apply R1 exactly as before — supervisor decides.
    const decision = supervisor.report(index, 'died');
    if (decision === 'restart') {
      logger.warn(`restarting worker ${index + 1}`);
      void spawn(index);
    } else if (decision === 'lost') {
      // Slot permanently lost, but the pool still has workers.
      emitWorkerLost(index, error);
    } else if (decision === 'fail-client') {
      // Last worker gone — emit loss (with live=0) before failing the client.
      emitWorkerLost(index, error);
      failClient(error);
    }
  };

  // Initialize the worker pool with the requested number of workers
  for (let index = 0; index < poolSize; index += 1) spawn(index);

  // Return the public API
  const api = {
    chunk,
    read,
    write,
    stream,
    first,
    transaction,
    bulkWrite,
    output,
    close,

    debug,
  };
  return api;
};
