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
