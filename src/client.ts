import { createBulk } from './bulk';
import { type ClientDebugState, createClientDebug } from './debug';
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
import { createTransaction, type TransactionDB } from './transaction';
import {
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteQueryOptions,
  type SQLiteVFS,
  VFS_BUILDS,
} from './types';
import { assertReadable, normalizeDatabaseFile, renderPragmas } from './utils';

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
   * Virtual File System implementation used for SQLite storage.
   * Controls whether data is stored in OPFS, IndexedDB, or memory.
   * See the README VFS Selection guide for a comparison.
   * @defaultValue `'OPFSAdaptiveVFS'`
   */
  vfs?: SQLiteVFS;
  /**
   * Which wa-sqlite WebAssembly build to load. Defaults to the first entry of
   * `VFS_BUILDS[vfs]` — `sync` where the VFS supports it, since it is both the
   * fastest and the most portable, otherwise `async`. `jspi` is Chromium-only.
   *
   * @throws at construction when the build is not one the chosen VFS supports.
   */
  build?: SQLiteBuild;

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
 * Main SQLite database API.
 */
export type SQLiteDB = {
  /**
   * Executes a SELECT query and returns all matching rows as an array.
   *
   * Read queries are dispatched to any available worker in the pool,
   * enabling concurrent execution across multiple readers.
   *
   * @param sql - SQL query string. Must be a SELECT (or equivalent read) statement.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional query options (`chunkSize`, `signal`, `id`).
   * @returns Promise resolving to an array of typed rows (`T[]`). Returns `[]` for empty results.
   */
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: any[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<T[]>;

  /**
   * Executes a DML or DDL statement (INSERT, UPDATE, DELETE, CREATE, DROP, etc.)
   * and returns both any result rows and the number of affected rows.
   *
   * Write queries are serialized through a single dedicated writer worker.
   * Concurrent writes queue behind each other — only one write executes at a time.
   *
   * @param sql - SQL statement. Any statement not classified as a read by `isReadQuery`.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional query options (`signal`, `id`).
   * @returns Promise resolving to `{ result: T[], affected: number }` where
   *   `affected` is the SQLite `changes()` count for the statement.
   */
  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: any[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
  ) => Promise<{ result: T[]; affected: number }>;

  /**
   * Executes a query and yields result rows in chunks via an async generator.
   * Memory-efficient for large result sets — rows are not buffered in full.
   *
   * @remarks
   * **Worker held for full generator lifetime.** A pool worker is acquired when
   * the generator is created and released only when the generator is fully
   * exhausted or the caller uses `break`. Failing to exhaust the generator
   * starves the pool. Always use `for await...of` to completion or `break` to exit.
   *
   * **`NOT_A_READ_QUERY` timing.** Because `chunk()` is an async generator, its
   * body does not run until the first `next()` call. Passing a write statement
   * does not throw at the call site — the `SQLiteError` arrives on the first
   * `await gen.next()` (or the first iteration of `for await...of`).
   *
   * @param sql - SQL query string. Must be a SELECT (or equivalent read) statement.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional options including `chunkSize` (default `500`),
   *   `signal` (AbortSignal to cancel).
   * @returns AsyncGenerator yielding `T[]` chunks of at most `chunkSize` rows.
   */
  chunk: <T extends Record<string, unknown>>(
    sql: string,
    params?: any[],
    options?: { chunkSize?: number; signal?: AbortSignal },
  ) => AsyncGenerator<T[]>;

  /**
   * Executes a query and yields individual result rows via an async generator.
   * Flattens chunk boundaries — each iteration yields one `T` row, not a chunk.
   * Use `chunk()` when you need the rows grouped by chunk.
   *
   * @remarks
   * **`NOT_A_READ_QUERY` timing.** Because `stream()` is an async generator, its
   * body does not run until the first `next()` call. Passing a write statement
   * does not throw at the call site — the `SQLiteError` arrives on the first
   * `await gen.next()` (or the first iteration of `for await...of`).
   *
   * @param sql - SQL query string. Must be a SELECT (or equivalent read) statement.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional query options (`signal`, `id`).
   * @returns AsyncGenerator yielding individual rows of type `T`.
   */
  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: any[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
  ) => AsyncGenerator<T>;

  /**
   * Executes a query and returns the first row, or `undefined` if no rows match.
   *
   * Internally uses `chunkSize: 1` and asks the worker to stop after the first
   * row. Because the worker runs in a separate thread it may race ahead between
   * the break and the stop signal, so early termination is best-effort on small
   * result sets. A hard bound will arrive with back-pressure in a future wave.
   *
   * @param sql - SQL query string.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional query options (`signal`, `id`).
   * @returns Promise resolving to the first row as `T`, or `undefined` if no rows.
   */
  first: <T extends Record<string, unknown>>(
    sql: string,
    params?: any[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize'>,
  ) => Promise<T | undefined>;

  /**
   * Executes a callback within a SQLite transaction, providing a scoped
   * `TransactionDB` with `read`, `write`, `chunk`, `stream`, `first`,
   * `commit`, and `rollback` methods.
   *
   * The worker is held exclusively for the transaction's duration.
   * On callback success: auto-commits if `autoCommit` is `true` (default).
   * On callback error: rolls back automatically.
   * The callback may call `db.commit()` or `db.rollback()` manually.
   *
   * @remarks
   * **Worker crash mid-transaction.** If the worker dies while the callback is
   * running, the transaction rejects with a `WORKER_CRASHED` error. The
   * database engine inside the terminated worker handles its own rollback, but
   * any OPFS file lock the worker held is not released until the browser
   * reclaims the terminated worker's file handles — the timing of that
   * reclamation is outside this library's control.
   *
   * @param callback - Async function receiving a `TransactionDB` instance.
   * @param options - `readOnly` (default `false`) prevents write statements;
   *   `autoCommit` (default `true`) commits on callback success.
   * @returns Promise resolving to the value returned by `callback`.
   */
  transaction: <T = void>(
    callback: (db: TransactionDB) => Promise<T>,
    options?: { readOnly?: boolean; autoCommit?: boolean },
  ) => Promise<T>;

  /**
   * Creates a buffered bulk-insert utility that batches rows to stay within
   * SQLite's variable limit (`SQLITE_MAX_VARS = 32766`).
   *
   * Call `enqueue()` for each row to insert, then `close()` to flush the
   * remaining buffer and await completion.
   *
   * @param table - Target table name.
   * @param keys - Column names for the INSERT statement.
   * @returns Object with:
   *   - `enqueue(data)` — buffers a row, flushing automatically when the buffer fills.
   *   - `close()` — flushes remaining rows and resolves with total affected row count.
   */
  bulkWrite: <KEYS extends string>(
    table: string,
    keys: KEYS[],
  ) => {
    enqueue: (data: Record<KEYS, any>) => void;
    close: () => Promise<number>;
  };

  /**
   * Schema-driven table replacement: drops the existing table, creates a new one
   * from the provided schema, bulk-inserts all enqueued rows, then creates indexes.
   *
   * Useful for full-refresh ETL patterns where a table is rebuilt from scratch.
   *
   * @param table - Table name to drop and recreate.
   * @param schema - Column definition map. Values are SQL type strings or
   *   objects with `{ type, required?, unique?, generated? }`.
   * @param options - `indexes` array for index creation after the swap.
   * @returns Object with `enqueue(data)` and `close()` following the same
   *   contract as {@link SQLiteDB.bulkWrite}.
   */
  output: <SCHEMA extends Record<string, any>>(
    table: string,
    schema: SCHEMA,
    options?: any,
  ) => { enqueue: (data: any) => void; close: () => Promise<number> };

  /**
   * Drains in-flight work, rejects queued work, closes each database connection,
   * then terminates all workers in the pool.
   *
   * The returned promise settles once every worker has posted `closed` and been
   * terminated, or once `drainTimeout` milliseconds have elapsed (whichever
   * comes first). Calling `close()` a second time returns the **same** promise
   * object — the operation runs exactly once.
   *
   * @remarks
   * **OPFS files are NOT deleted.** `close()` does not remove any OPFS database
   * files. Files created by browser-sqlite persist in the origin's private file
   * system across page loads. To delete OPFS files, use the
   * `navigator.storage.getDirectory()` API directly.
   */
  close: () => Promise<void>;

  /**
   * Internal diagnostic handle. Not part of the stable public API.
   * Shape is subject to change without notice.
   * @internal
   */
  debug?: ClientDebugState;
};

const DEFAULT_VFS = 'OPFSAdaptiveVFS';

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
 * @param clientOptions - Optional pool and VFS configuration.
 *   See {@link CreateSQLiteClientOptions} for field defaults.
 * @returns A {@link SQLiteDB} object providing `read`, `write`, `chunk`,
 *   `stream`, `first`, `transaction`, `bulkWrite`, `output`, and `close` methods.
 *
 * @throws {SQLiteError} With code `INVALID_OPTION` when `build` is not one of
 *   the builds the chosen `vfs` supports. The message names the supported
 *   builds; the pairing is declared once, in `VFS_BUILDS`.
 * @throws {Error} When `vfs` is `'AccessHandlePoolVFS'` and `poolSize` is
 *   greater than `1`. AccessHandlePoolVFS does not support concurrent access
 *   handles — set `poolSize: 1` explicitly when using this VFS.
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
  clientOptions?: CreateSQLiteClientOptions,
) => {
  // One definition of database identity for the workers, the VFS, the epoch
  // registry, every lock name and the returned `db.file`.
  const dbFile = normalizeDatabaseFile(file);

  const clientIndex = ++clientCount;

  const clientPrefix = `${clientOptions?.name ?? 'SQLite'} ${clientIndex}`;

  const poolSize = clientOptions?.poolSize ?? DEFAULT_POOL_SIZE;
  const pool: (PoolWorker | undefined)[] = [];

  const vfs = clientOptions?.vfs ?? DEFAULT_VFS;
  const build = clientOptions?.build ?? defaultBuildFor(vfs);

  // Synchronous, like the AccessHandlePoolVFS guard below: an unsupported
  // combination must fail here and name itself, not surface later as an opaque
  // open-error from a worker that could not instantiate its module.
  if (!(VFS_BUILDS[vfs] as readonly SQLiteBuild[]).includes(build)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} cannot run on the '${build}' build. Supported: ${VFS_BUILDS[vfs].join(', ')}.`,
    );
  }

  if (vfs === 'AccessHandlePoolVFS' && poolSize > 1) {
    throw new Error(
      'AccessHandlePoolVFS does not support pool sizes greater than 1',
    );
  }

  // Fail at construction, not inside the first unrelated query.
  if (clientOptions?.pragmas) renderPragmas(clientOptions.pragmas);

  // TEST-ONLY, UNSUPPORTED. Read once here, validated, and converted to a
  // typed internal value so no `any` travels further. Absent from the public
  // options type on purpose — see InternalSQLiteClientOptions in scheduler.ts.
  const testWriterPolicy = (
    clientOptions as InternalSQLiteClientOptions | undefined
  )?.__unsafeTestWriterPolicy;
  const writerPolicy: WriterPolicy | undefined =
    typeof testWriterPolicy === 'function' ? testWriterPolicy : undefined;

  /**
   * Creates a new pool worker and adds it to the pool.
   * Sets up message routing via callId for query responses.
   */
  const scheduler = createScheduler<PoolWorker>(
    writerPolicy ? { canDesignateWriter: writerPolicy } : {},
  );

  const debugOption = clientOptions?.debug;

  const debugPrefix =
    typeof debugOption === 'string' ? debugOption : clientPrefix;

  const logger = createLogger(debugPrefix, !!debugOption);

  const clientDebug = debugOption
    ? createClientDebug(
        dbFile,
        pool,
        {
          vfs,
          pragmas: clientOptions?.pragmas ?? {},
          name: clientOptions?.name ?? 'SQLite',
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
   * There are seven acquisition sites; instrumenting each is seven chances to
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
    options?: SQLiteQueryOptions<T>,
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
  >(
    sql: string,
    params?: unknown[],
    options?: { chunkSize?: number; signal?: AbortSignal },
  ) {
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
  >(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) {
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
    options?: SQLiteQueryOptions<T>,
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
    options?: { signal?: AbortSignal },
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

  const transaction = createTransaction({
    scheduler: { ...scheduler, acquire: acquireInstrumented },
    afterWrite,
    // Wrapped, not passed by reference: handleDeath is declared further down
    // and would be in its temporal dead zone here.
    onPoisoned: (index, error) => handleDeath(index, error),
  });

  const { bulkWrite, output } = createBulk({
    write,
    read,
    transaction,
    file: dbFile,
    locks: createLocks(),
    logger,
  });

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

  const openTimeout = clientOptions?.openTimeout ?? 30_000;
  const drainTimeout = clientOptions?.drainTimeout ?? 60_000;

  const supervisor = createSupervisor({
    size: poolSize,
    maxWorkerRestarts: clientOptions?.maxWorkerRestarts,
  });

  let fatal: SQLiteError | undefined;

  const failClient = (error: SQLiteError) => {
    fatal ??= error;
    void scheduler.shutdown(fatal);
    for (const dying of pool) dying?.terminate();
  };

  const spawn = (index: number) => {
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
      // Pass the original (un-normalized) name: sqlite3_open_v2 checks
      // nPathname + 8 > mxPathname (64, wa-sqlite/src/VFS.js:10) before xOpen,
      // so normalization's leading '/' breaks 56-char names (measured: all 96
      // browser tests failed). Four of the five VFS normalize via
      // new URL(zName, 'file://') internally — 'data' and '/data' open the same
      // OPFS file. OPFSWriteAheadVFS splits on '/' itself: 'data' vs '/data'
      // still lands on the same file (empty segments dropped), but './data'
      // would throw there — that defect is not fixed at this call site.
      // The normalized dbFile is the identity key for client-side registries
      // and lock names; the worker normalizes independently for its lock name.
      file,
      vfs,
      build,
      pragmas: clientOptions?.pragmas,
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
