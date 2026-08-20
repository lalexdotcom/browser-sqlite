/**
 * Every failure this library raises on its own behalf. A caller discriminates
 * on `code`, or on `name` — they carry the same value, so `err.name` reads the
 * way `'AbortError'` does on the DOMException an aborted signal throws.
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
  | 'BULK_WRITE_FAILED';

export class SQLiteError extends Error {
  readonly code: SQLiteErrorCode;

  constructor(
    code: SQLiteErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.code = code;
    this.name = code;
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
export class BulkWriteError extends SQLiteError {
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
