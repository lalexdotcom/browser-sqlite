import { createBulk } from './bulk';
import type { createClientDebug } from './debug';
import { WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import { createPoolWorker, type PoolWorker } from './pool';
import {
  chunk as chunkWorker,
  firstWorker,
  readWorker,
  streamRows,
  writeWorker,
} from './queries';
import { createScheduler } from './scheduler';
import { createTransaction, type TransactionDB } from './transaction';
import type { SQLiteQueryOptions, SQLiteVFS } from './types';
import { isWriteQuery } from './utils';

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
   * @defaultValue `'OPFSPermutedVFS'`
   */
  vfs?: SQLiteVFS;

  /**
   * SQLite PRAGMAs applied to each worker's database connection on open.
   * Keys are PRAGMA names, values are their string representations.
   * Example: `{ journal_mode: 'WAL', synchronous: 'NORMAL' }`.
   * If omitted, no PRAGMAs are applied beyond SQLite defaults.
   */
  pragmas?: Record<string, string>;
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
   * @param sql - SQL statement. Any statement recognized as a write by `isWriteQuery`.
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
   * @param sql - SQL query string.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional options including `chunkSize` (default `500`),
   *   `signal` (AbortSignal to cancel), and `id`.
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
   * @param sql - SQL query string.
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
   * @param options - `indexes` array and `temp` flag for TEMPORARY tables.
   * @returns Object with `enqueue(data)` and `close()` following the same
   *   contract as {@link SQLiteDB.bulkWrite}.
   */
  output: <SCHEMA extends Record<string, any>>(
    table: string,
    schema: SCHEMA,
    options?: any,
  ) => { enqueue: (data: any) => void; close: () => Promise<number> };

  /**
   * Terminates all workers in the pool.
   *
   * @remarks
   * **OPFS files are NOT deleted.** `close()` calls `worker.terminate()` on each
   * pool worker — it does not remove any OPFS database files. Files created by
   * browser-sqlite persist in the origin's private file system across page loads.
   * To delete OPFS files, use the `navigator.storage.getDirectory()` API directly.
   */
  close: () => void;

  /**
   * Internal diagnostic handle. Not part of the stable public API.
   * Shape is subject to change without notice.
   * @internal
   */
  debug: unknown;
};

const DEFAULT_VFS = 'OPFSPermutedVFS';

/**
 * Creates a SQLite client backed by a pool of Web Workers, each running
 * a wa-sqlite instance in a dedicated thread.
 *
 * @remarks
 * **Browser requirements (COOP/COEP):** This function constructs a
 * `SharedArrayBuffer` for cross-thread worker synchronization. Browsers
 * require the page to be served with the following HTTP headers:
 * ```
 * Cross-Origin-Opener-Policy: same-origin
 * Cross-Origin-Embedder-Policy: require-corp
 * ```
 * Without these headers, `new SharedArrayBuffer()` throws a `SecurityError`
 * and the pool will never initialize.
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
 *   vfs: 'OPFSPermutedVFS',
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
  const clientIndex = ++clientCount;

  const clientPrefix = `${clientOptions?.name ?? 'SQLite'} ${clientIndex}`;

  const poolSize = clientOptions?.poolSize ?? DEFAULT_POOL_SIZE;
  const pool: PoolWorker[] = [];

  // Orchestrator manages worker synchronization and status tracking
  const orchestrator = new WorkerOrchestrator(poolSize);

  const vfs = clientOptions?.vfs ?? DEFAULT_VFS;

  if (vfs === 'AccessHandlePoolVFS' && poolSize > 1) {
    throw new Error(
      'AccessHandlePoolVFS does not support pool sizes greater than 1',
    );
  }

  const { state: debug } = {} as ReturnType<typeof createClientDebug>;

  /**
   * Creates a new pool worker and adds it to the pool.
   * Sets up message routing via callId for query responses.
   */
  const scheduler = createScheduler<PoolWorker>({
    onIdle: (worker) =>
      orchestrator.setStatus(worker.index, WorkerStatuses.READY),
  });

  /**
   * Executes a read query and returns all results.
   * Automatically acquires and releases a worker from the pool.
   */
  const read = async <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => {
    const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
    try {
      return await readWorker<T>(lease.worker, sql, params, options);
    } finally {
      lease.release();
    }
  };

  /**
   * Executes a query and yields result rows in chunks.
   * The single abort-aware primitive — all other read paths derive from this.
   */
  const chunk = async function* <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: { chunkSize?: number; signal?: AbortSignal },
  ) {
    const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
    try {
      yield* chunkWorker<T>(lease.worker, sql, params, options);
    } finally {
      lease.release();
    }
  };

  /**
   * Executes a query and streams individual rows (flattened from chunks).
   */
  const stream = async function* <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, params?: unknown[], options?: SQLiteQueryOptions<T>) {
    const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
    try {
      yield* streamRows<T>(lease.worker, sql, params, options);
    } finally {
      lease.release();
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
    const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
    try {
      return await writeWorker<T>(lease.worker, sql, params, options);
    } finally {
      lease.release();
    }
  };

  /**
   * Executes a query and returns only the first row.
   * Breaks after the first chunk — no internal AbortController needed.
   */
  const first = async <
    T extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params?: unknown[],
    options?: { signal?: AbortSignal },
  ) => {
    const lease = await scheduler.acquire(isWriteQuery(sql) ? 'write' : 'read');
    try {
      return await firstWorker<T>(lease.worker, sql, params, options);
    } finally {
      lease.release();
    }
  };

  const { bulkWrite, output } = createBulk({ write });

  const transaction = createTransaction({ scheduler });

  /**
   * Terminates all workers and cleans up the pool.
   */
  const close = () => {
    let worker = pool.shift();
    while (worker !== undefined) {
      worker.terminate();
      worker = pool.shift();
    }
  };

  // Initialize the worker pool with the requested number of workers
  Promise.all(
    Array.from({ length: poolSize }).map(() =>
      createPoolWorker({
        orchestrator,
        pool,
        clientPrefix,
        file,
        vfs,
        pragmas: clientOptions?.pragmas,
      }),
    ),
  ).then((allWorkers) => {
    for (const worker of allWorkers) scheduler.add(worker);
  });

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
