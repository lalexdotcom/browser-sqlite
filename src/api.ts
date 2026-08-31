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

/**
 * Marks an options type as carrying an abort signal.
 *
 * The name is the point. `options?: OptionsWithSignal<…>` says at the signature
 * that the method can be abandoned, where a bare alias would make a reader open
 * the type to find out. Every abortable option type in this file is built from
 * it, so `signal` is documented once and cannot drift between them.
 *
 * Not the bare `Abortable` that `@types/node` uses: this reads as an options
 * bag augmented with one member — `PropsWithChildren`, not an adjective — which
 * is what it is both wrapped, `OptionsWithSignal<{ chunkSize?: number }>`, and
 * alone, `options?: OptionsWithSignal`.
 *
 * `T = unknown` rather than `Record<string, never>`: intersecting with the
 * latter collapses `signal` to `never` and makes it unassignable.
 */
export type OptionsWithSignal<T = unknown> = T & {
  /**
   * Aborts the work. Rejects with `signal.reason` — your reason, not an error
   * of this library's making.
   *
   * On `bulkWrite()` and `output()` the abort lands **between** batches, never
   * inside one: a multi-row INSERT is statement-atomic, so stopping inside a
   * batch would either waste it whole or let it commit whole. An aborted
   * `bulkWrite()` leaves the batches already written in place; an aborted
   * `output()` is observationally a no-op, dropping its staging table and
   * touching nothing else.
   */
  signal?: AbortSignal | undefined;
};

/** Options every query method accepts. */
export type SQLiteQueryOptions = OptionsWithSignal;

/**
 * Options for the methods that cross the worker boundary in chunks.
 *
 * `chunkSize` is not only a transport detail: back-pressure grants credits per
 * chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows
 * ahead of the consumer. On `stream()` that is the only lever on how many rows
 * are in flight.
 */
export type SQLiteChunkOptions = OptionsWithSignal<{
  /** Rows per chunk. Defaults to 500. */
  chunkSize?: number;
}>;

export type SQLiteWriteResult<T extends Record<string, unknown>> = {
  result: T[];
  affected: number;
};

/**
 * Options for `transaction()`.
 *
 * `signal` abandons the transaction at every stage: while it waits for a
 * worker, once it holds one, and from inside the callback — every statement
 * issued through `tx` inherits it, and a statement that carries a signal of its
 * own can be aborted by either. An abandoned transaction rolls back and rejects
 * with `signal.reason`; it never commits, not even when the callback catches
 * its statement's rejection and returns normally.
 *
 * The callback itself cannot be interrupted — it is your code — but it can no
 * longer reach the database: every statement it issues after the abort rejects
 * without a worker round trip.
 *
 * One window is not abortable: `BEGIN`, `COMMIT` and `ROLLBACK` never carry the
 * signal. Their completion is what decides whether a rollback is owed, so a
 * client-side abort of one of them would risk leaving the transaction open on
 * the connection. The abort lands as soon as such a statement settles.
 *
 * That window is short on a VFS holding one access handle per connection, and
 * it is not on a VFS rotating a single exclusive one: there such a statement
 * waits for whichever client holds the file, and your signal cannot shorten
 * that wait. See the reduced mode described under VFS Selection.
 */
export type SQLiteTransactionOptions = OptionsWithSignal<{
  /** Rejects write statements with `READ_ONLY_TRANSACTION`. Defaults to false. */
  readOnly?: boolean;
  /** Commits when the callback resolves. Defaults to true. */
  autoCommit?: boolean;
}>;

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

export type SQLiteOutputOptions<SCHEMA extends Schema> = OptionsWithSignal<{
  indexes?: Index<SCHEMA>[];
  /** Rows queued for writing above which `enqueue()` defers. See `SQLiteBulkWriteOptions`. */
  queueSize?: number | undefined;
}>;

/**
 * Options `bulkWrite()` accepts.
 *
 * `queueSize` bounds how far the producer may run ahead of the database. Rows
 * are handed over in batches of at most 32 766 bound values; a batch that has
 * been handed over but not yet written is held in memory until it is, and
 * nothing caps how many of those accumulate unless you await `enqueue()`.
 *
 * It is a number of rows, and nothing else: it says nothing about what those
 * rows weigh. A table whose columns carry blobs holds far more per row than a
 * table of integers, and only you know which one you are loading — set the
 * value yourself when the rows are heavy.
 *
 * The default is two batches' worth, derived from the column count: about
 * 13 100 rows for 5 columns, 2 180 for 30. A value smaller than one batch is legal
 * and means one INSERT in flight, the least the batching allows. Anything below
 * 1 is raised to 1: a batch always holds at least one row, so a lower cap could
 * never be satisfied.
 */
export type SQLiteBulkWriteOptions = OptionsWithSignal<{
  /** Rows queued for writing above which `enqueue()` defers. */
  queueSize?: number | undefined;
}>;

/** A row for `output()`: generated columns are computed, never supplied. */
export type SQLiteOutputRow<SCHEMA extends Schema> = {
  [K in keyof SCHEMA as SCHEMA[K] extends { generated: string }
    ? never
    : K]: any;
};

/**
 * Buffers a row, flushing automatically when the buffer fills.
 *
 * Awaiting the returned promise applies back-pressure: it is already resolved
 * while fewer than `queueSize` rows are queued for writing, and resolves once
 * a batch settles when they are not. Ignoring it is legal, and leaves the load
 * unbounded exactly as it was before the option existed — the bound is an
 * offer, not a guarantee.
 *
 * It never rejects. A failed batch surfaces at the next `enqueue()`, which
 * throws, and at `close()`, which rejects.
 */
type EnqueueRow<ROW> = (data: ROW) => Promise<void>;

export type SQLiteBulkWriter<KEYS extends string> = {
  enqueue: EnqueueRow<Record<KEYS, any>>;
  /** Flushes what remains and resolves with the total affected row count. */
  close: () => Promise<number>;
};

export type SQLiteOutputWriter<SCHEMA extends Schema> = {
  enqueue: EnqueueRow<SQLiteOutputRow<SCHEMA>>;
  close: () => Promise<number>;
};

/**
 * The querying surface, shared by the client and by a transaction.
 *
 * It exists so the two cannot drift: they had already done so, one taking
 * `any[]` where the other took `unknown[]`, and two different option types on
 * `chunk`. A method added to one is now added to both by construction.
 *
 * @remarks
 * **The row type parameter is a claim, not a check.** `read<T>`, `first<T>`,
 * `chunk<T>` and `stream<T>` cast SQLite's output to `T` and validate nothing:
 * a column that is missing, renamed or of another type reaches you typed as if
 * it were not. SQLite is dynamically typed and a query's shape is only known at
 * runtime, so the alternative would be a schema the caller declares twice.
 * Validate at the boundary if you need the guarantee — this is `as`, not a
 * parser.
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
    options?: OptionsWithSignal,
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
   * @param options - Optional query options (`chunkSize`, `signal`).
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
    options?: OptionsWithSignal,
  ) => Promise<T | undefined>;

  /**
   * Creates a buffered bulk-insert utility that batches rows to stay within
   * SQLite's variable limit (`SQLITE_MAX_VARS = 32766`).
   *
   * Call `enqueue()` for each row to insert, then `close()` to flush the
   * remaining buffer and await completion.
   *
   * @remarks
   * **`bulkWrite()` is not atomic:** batches are committed as they flush, so a
   * failure leaves the rows already written in place. Call it on a `tx` if you
   * need all-or-nothing.
   *
   * That commit per batch is also what it costs: measured at ~3.4 ms
   * (synchronous build) and ~5.3 ms (Asyncify build) per commit on Chromium.
   * A load wrapped in `transaction()` commits once and buys the rest back.
   *
   * @param table - Target table name.
   * @param keys - Column names for the INSERT statement.
   * @param options - `signal` aborts the load between batches. `close()` then
   *   rejects with `signal.reason`. **The batches already flushed stay
   *   written** — `bulkWrite()` is not atomic outside a transaction, so an
   *   abort stops the load, it does not undo it. Run it inside `transaction()`
   *   when abandoning must mean rolling back.
   * @returns Object with:
   *   - `enqueue(data)` — buffers a row, flushing automatically when the buffer fills.
   *   - `close()` — flushes remaining rows and resolves with total affected row count.
   */
  bulkWrite: <KEYS extends string>(
    table: string,
    keys: KEYS[],
    options?: SQLiteBulkWriteOptions,
  ) => SQLiteBulkWriter<KEYS>;

  /**
   * Schema-driven table replacement: drops the existing table, creates a new one
   * from the provided schema, bulk-inserts all enqueued rows, then creates indexes.
   *
   * Useful for full-refresh ETL patterns where a table is rebuilt from scratch.
   *
   * @remarks
   * **Inside a transaction, `output()` costs more than it looks.** On its own it
   * loads rows outside any transaction and holds the write lock only for the
   * final swap. Called on a `tx`, the entire load runs inside your transaction —
   * every other write, in this tab and in others, waits for it to finish.
   *
   * @param table - Table name to drop and recreate.
   * @param schema - Column definition map. Values are SQL type strings or
   *   objects with `{ type, required?, unique?, generated? }`.
   * @param options - `indexes` array for index creation after the swap, and
   *   `signal` to abort the load. An aborted `output()` leaves the previous
   *   target intact and untouched.
   * @returns Object with `enqueue(data)` and `close()` following the same
   *   contract as {@link SQLiteQueryAPI.bulkWrite}.
   */
  output: <SCHEMA extends Schema>(
    table: string,
    schema: SCHEMA,
    options?: SQLiteOutputOptions<SCHEMA>,
  ) => SQLiteOutputWriter<SCHEMA>;
};

export type SQLiteDB = SQLiteQueryAPI & {
  /**
   * Executes a callback within a SQLite transaction, providing a scoped
   * `SQLiteTransactionDB` with `read`, `write`, `chunk`, `stream`, `first`,
   * `bulkWrite`, `output`, `commit`, and `rollback` methods.
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
