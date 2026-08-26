/**
 * The public type layer. Everything here is part of the package's API, which is
 * why `index.ts` re-exports this module wholesale: a name list is what let
 * `SQLiteQueryOptions` and `TransactionDB` end up in the shipped `.d.ts`
 * without a consumer being able to name either.
 *
 * `types.ts` keeps the wire protocol and the VFS capability table.
 * `CreateSQLiteClientOptions` stays in `client.ts`, beside the constructor that
 * validates it: this module is the querying surface and its satellites — what a
 * caller passes to a query, and what comes back.
 */
import type { ClientDebugState } from './debug';

/** Options every query method accepts. */
export type SQLiteQueryOptions = {
  /** Aborts the query. Rejects with `signal.reason`. */
  signal?: AbortSignal;
};

/**
 * Options for the methods that cross the worker boundary in chunks.
 *
 * `chunkSize` is not only a transport detail: back-pressure grants credits per
 * chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows
 * ahead of the consumer. On `stream()` that is the only lever on how many rows
 * are in flight.
 */
export type SQLiteChunkOptions = SQLiteQueryOptions & {
  /** Rows per chunk. Defaults to 500. */
  chunkSize?: number;
};

/** What a write resolves with: any returned rows, and SQLite's `changes()`. */
export type SQLiteWriteResult<T extends Record<string, unknown>> = {
  result: T[];
  affected: number;
};

export type SQLiteTransactionOptions = {
  /** Rejects write statements with `READ_ONLY_TRANSACTION`. Defaults to false. */
  readOnly?: boolean;
  /** Commits when the callback resolves. Defaults to true. */
  autoCommit?: boolean;
};

/** Column definitions for `output()`. */
export type Schema = Record<
  string,
  | string
  | { type: string; generated?: string; required?: boolean; unique?: boolean }
>;

export type Index<SCHEMA extends Schema> =
  | keyof SCHEMA
  | (keyof SCHEMA)[]
  | ({ unique?: boolean } & (
      | { column: keyof SCHEMA }
      | { columns: (keyof SCHEMA)[] }
    ));

export type SQLiteOutputOptions<SCHEMA extends Schema> = {
  indexes?: Index<SCHEMA>[];
};

/** A row for `output()`: generated columns are computed, never supplied. */
export type SQLiteOutputRow<SCHEMA extends Schema> = {
  [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
    ? never
    : K]: any;
};

export type SQLiteBulkWriter<KEYS extends string> = {
  /** Buffers a row, flushing automatically when the buffer fills. */
  enqueue: (data: Record<KEYS, any>) => void;
  /** Flushes what remains and resolves with the total affected row count. */
  close: () => Promise<number>;
};

export type SQLiteOutputWriter<SCHEMA extends Schema> = {
  enqueue: (data: SQLiteOutputRow<SCHEMA>) => void;
  close: () => Promise<number>;
};

/**
 * The querying surface, shared by the client and by a transaction.
 *
 * It exists so the two cannot drift: they had already done so, one taking
 * `any[]` where the other took `unknown[]`, and two different option types on
 * `chunk`. A method added to one is now added to both by construction.
 */
export type SQLiteQueryAPI = {
  /**
   * Executes a SELECT query and returns all matching rows as an array.
   *
   * Read queries are dispatched to any available worker in the pool,
   * enabling concurrent execution across multiple readers.
   *
   * @param sql - SQL query string. Must be a SELECT (or equivalent read) statement.
   * @param params - Positional parameters bound to `?` placeholders.
   * @param options - Optional query options (`chunkSize`, `signal`).
   * @returns Promise resolving to an array of typed rows (`T[]`). Returns `[]` for empty results.
   */
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteChunkOptions,
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
   * @param options - Optional query options (`signal`).
   * @returns Promise resolving to `{ result: T[], affected: number }` where
   *   `affected` is the SQLite `changes()` count for the statement.
   */
  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions,
  ) => Promise<SQLiteWriteResult<T>>;

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
    params?: unknown[],
    options?: SQLiteChunkOptions,
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
   * @param options - Optional query options (`signal`).
   * @returns AsyncGenerator yielding individual rows of type `T`.
   */
  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteChunkOptions,
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
   * @param options - Optional query options (`signal`).
   * @returns Promise resolving to the first row as `T`, or `undefined` if no rows.
   */
  first: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions,
  ) => Promise<T | undefined>;
};

export type SQLiteDB = SQLiteQueryAPI & {
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
  ) => SQLiteBulkWriter<KEYS>;

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
  output: <SCHEMA extends Schema>(
    table: string,
    schema: SCHEMA,
    options?: SQLiteOutputOptions<SCHEMA>,
  ) => SQLiteOutputWriter<SCHEMA>;

  /**
   * Executes a callback within a SQLite transaction, providing a scoped
   * `SQLiteTransactionDB` with `read`, `write`, `chunk`, `stream`, `first`,
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
   * @param callback - Async function receiving a `SQLiteTransactionDB` instance.
   * @param options - `readOnly` (default `false`) prevents write statements;
   *   `autoCommit` (default `true`) commits on callback success.
   * @returns Promise resolving to the value returned by `callback`.
   */
  transaction: <T = void>(
    callback: (db: SQLiteTransactionDB) => Promise<T>,
    options?: SQLiteTransactionOptions,
  ) => Promise<T>;

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
   * **Stored data is NOT deleted.** `close()` releases workers and connections;
   * it removes nothing. What a database leaves behind, and how to remove it,
   * depends on the VFS — and this library does not yet expose a deletion that
   * routes through the VFS itself.
   *
   * Deleting files under `navigator.storage.getDirectory()` is only correct for
   * the plain OPFS VFS, on a database that is already closed, and even there it
   * leaves SQLite's `-journal` and `-wal` siblings unless you remove them too.
   * It is wrong elsewhere:
   *
   * - `AccessHandlePoolVFS` keeps every database inside one directory named
   *   after the VFS, in a fixed set of pre-allocated files with opaque names.
   *   Removing a file does not free its slot — it takes capacity away from the
   *   pool, and once capacity runs out no further database opens.
   * - `IDBBatchAtomicVFS` and `IDBMirrorVFS` store nothing in OPFS at all;
   *   their data lives in an IndexedDB database named after the VFS class, so
   *   an OPFS deletion is a no-op.
   *
   * Until a `deleteDatabase` exists here, treat removal as VFS-specific and
   * check what your chosen VFS actually writes.
   */
  close: () => Promise<void>;

  /**
   * Internal diagnostic handle. Not part of the stable public API.
   * Shape is subject to change without notice.
   * @internal
   */
  debug?: ClientDebugState;
};

export type SQLiteTransactionDB = SQLiteQueryAPI & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};
