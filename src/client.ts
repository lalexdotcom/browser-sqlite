import type { SQLiteChunkOptions, SQLiteDB, WithSignal } from './api';
import { createBulk } from './bulk';
import {
  describeMissing,
  detectFeatures,
  missingFeature,
} from './capabilities';
import { createClientDebug } from './debug';
import { advanceSeen, BARRIER_SQL, epochsFor } from './epochs';
import { SQLiteError } from './errors';
import { createLocks } from './locks';
import { createLogger } from './logger';
import { createPoolWorker, type PoolWorker } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
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

  /**
   * Creates a new pool worker and adds it to the pool.
   * Sets up message routing via callId for query responses.
   */
  const scheduler = createScheduler<PoolWorker>(
    writerPolicy ? { canDesignateWriter: writerPolicy } : {},
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

  const epochs = epochsFor(dbFile);

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
  const acquireWithDebug = async (kind: 'read' | 'write') => {
    // Called only when clientDebug is set — cast to NonNullable to avoid the
    // forbidden non-null assertion operator while preserving the correct type.
    const request = (
      clientDebug as NonNullable<typeof clientDebug>
    ).createRequestDebugState();
    const lease = await scheduler.acquire(kind);
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
  const acquireInstrumented = async (kind: 'read' | 'write') => {
    const lease = clientDebug
      ? await acquireWithDebug(kind)
      : await scheduler.acquire(kind);
    try {
      await applyBarrier(lease.worker);
    } catch (error) {
      // The caller never received the lease, so its try/finally cannot return
      // the worker. Release on the same path a normal caller would.
      void lease.worker.quiesce().then(
        () => lease.release(),
        () => lease.release(),
      );
      throw error;
    }
    return lease;
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
    options?: WithSignal,
  ) => {
    assertReadable(sql, 'read');
    const lease = await acquireInstrumented('read');
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
    const lease = await acquireInstrumented('read');
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
    const lease = await acquireInstrumented('read');
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
    options?: WithSignal,
  ) => {
    const lease = await acquireInstrumented('write');
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
    options?: WithSignal,
  ) => {
    assertReadable(sql, 'first');
    const lease = await acquireInstrumented('read');
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
      // Shutting the front door first: queued waiters reject at once and no new
      // work can be acquired while the in-flight work drains.
      const draining = scheduler.shutdown(
        new SQLiteError('CLIENT_CLOSED', 'The SQLite client has been closed.'),
      );
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
        scheduler.add(worker);
      })
      .catch(() => {
        // The rejection is the death already reported through onDeath.
      })
      .finally(() => clearTimeout(timer));
  };

  const handleDeath = (index: number, error: SQLiteError) => {
    scheduler.remove(index);
    pool[index]?.terminate();
    pool[index] = undefined;
    const decision = supervisor.report(index, 'died');
    if (decision === 'restart') {
      logger.warn(`restarting worker ${index + 1}`);
      void spawn(index);
    } else if (decision === 'fail-client') {
      logger.error(`worker ${index + 1} evicted`);
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
