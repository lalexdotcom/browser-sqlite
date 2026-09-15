import { SQLiteError } from 'wa-sqlite/src/sqlite-api.js';

/**
 * SQLite's result code on a thrown value, or undefined when SQLite did not
 * raise it (spec 2026-09-14, final review). wa-sqlite raises its own
 * `SQLiteError(message, code)` for every result code. Anything else carrying a
 * numeric `code` — a DOMException's legacy code, 18 for SecurityError — is
 * not SQLite's and must not be published as `sqliteCode`.
 */
export const sqliteCodeOf = (e: unknown): number | undefined =>
  e instanceof SQLiteError && typeof e.code === 'number' ? e.code : undefined;
