/**
 * Every failure this library raises on its own behalf. A caller discriminates
 * on `code`, or on `name` — they carry the same value, so `err.name` reads the
 * way `'AbortError'` does on the DOMException an aborted signal throws.
 * `DATABASE_IN_USE` is this library's own: a database that a live client holds,
 * as opposed to `BUSY`, which covers a transient conflict worth retrying.
 * `DATABASE_NOT_FOUND` is raised only by `deleteDatabase`: there is nothing at
 * that name to delete. `createSQLiteClient` creates what is absent, so it has
 * no such case.
 * `UNSUPPORTED` means the platform cannot answer the question — raised by
 * `inspectDatabase` where Web Locks is missing, because reporting zero clients
 * there would be indistinguishable from a database nobody holds.
 */
export type SQLiteErrorCode =
  | 'NOT_A_READ_QUERY'
  | 'CLIENT_CLOSED'
  | 'WORKER_CRASHED'
  | 'TIMEOUT'
  | 'PROTOCOL_ERROR'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_OPTION'
  | 'INVALID_PRAGMA'
  | 'BULK_WRITE_FAILED'
  | 'BUSY'
  | 'DATABASE_IN_USE'
  | 'DATABASE_NOT_FOUND'
  | 'READ_ONLY_TRANSACTION'
  | 'UNSUPPORTED';

export class SQLiteError extends Error {
  readonly code: SQLiteErrorCode;
  /**
   * SQLite's own numeric result code, present only when the failure came from
   * SQLite rather than from this library. `BUSY` covers both SQLITE_BUSY (5)
   * and SQLITE_LOCKED (6); this is how a caller tells them apart.
   */
  readonly sqliteCode?: number;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: { cause?: unknown; sqliteCode?: number },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
    if (options?.sqliteCode !== undefined) this.sqliteCode = options.sqliteCode;
  }
}

/**
 * A batch failed. Raised by `bulkWrite().close()` and by `output().close()`.
 *
 * The counters exist because the old behaviour was silent: batches were chained
 * on one shared promise, so after a rejection every later `.then` was skipped —
 * while their rows had already been spliced out of the buffer (B5). A caller now
 * learns how much of its data reached the database.
 */
export class SQLiteBulkWriteError extends SQLiteError {
  readonly rowsWritten: number;
  readonly rowsNotWritten: number;

  constructor(
    message: string,
    counts: { rowsWritten: number; rowsNotWritten: number },
    options?: { cause?: unknown },
  ) {
    super('BULK_WRITE_FAILED', message, options);
    this.rowsWritten = counts.rowsWritten;
    this.rowsNotWritten = counts.rowsNotWritten;
  }
}
