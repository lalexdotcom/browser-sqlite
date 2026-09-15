import { SQLiteError } from 'wa-sqlite/src/sqlite-api.js';
import type { SQLiteResultCode } from '../sqlite-codes';

/**
 * SQLite's result code on a thrown value, or undefined when SQLite did not
 * raise it (spec 2026-09-14, final review). wa-sqlite raises its own
 * `SQLiteError(message, code)` for every result code. Anything else carrying a
 * numeric `code` — a DOMException's legacy code, 18 for SecurityError — is
 * not SQLite's and must not be published as `sqliteCode`.
 */
export const sqliteCodeOf = (e: unknown): SQLiteResultCode | undefined =>
  e instanceof SQLiteError && typeof e.code === 'number'
    ? // wa-sqlite raises its SQLiteError with the return code of a SQLite C
      // call (or SQLITE_MISUSE for a JS-side misuse), and extended result
      // codes are never enabled on the connection — so this is always one
      // of the bundled SQLite's primary codes (D10).
      (e.code as SQLiteResultCode)
    : undefined;
