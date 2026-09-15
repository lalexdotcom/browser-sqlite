/**
 * The result codes of SQLite 3.53.0, keyed without the `SQLITE_` prefix, in two
 * tables that match `SQLiteError`'s two fields: test the family on `sqliteCode`
 * against `SQLITE_CODES` (`CONSTRAINT`, `FULL`), the subtype on
 * `sqliteExtendedCode` against `SQLITE_EXTENDED_CODES` (`CONSTRAINT_UNIQUE`).
 * An extended code's low byte is its family (`(2067 & 0xff) === 19`), and its key
 * begins with the family's key. What each one means:
 * https://sqlite.org/rescode.html.
 *
 * Transcribed from `src/sqlite.h.in` — the source of `sqlite3.h` — at SQLite's
 * tag `version-3.53.0`, checked 2026-09-14. That is the SQLite of the vendored
 * wa-sqlite, v1.1.2 (its `package.json` still reads 1.1.1: upstream did not
 * bump it): its source-id, read from the wasm, is `2026-04-09 11:41:38
 * 4525003a53a7fc63ca75`, and the tag's `manifest.uuid` begins with the same
 * hash. Not read from wa-sqlite's `sqlite-constants.js`, which has no
 * `BUSY_*`, `LOCKED_*`, `CANTOPEN_*`, `CORRUPT_*` or `READONLY_*` codes;
 * `tests/unit/sqlite-codes.test.ts` checks every name the two share.
 * Re-transcribe when wa-sqlite moves to another SQLite.
 *
 * `sqliteCode` and `sqliteExtendedCode` stay typed `number`, not a union of
 * these: a later SQLite may report a code these tables do not hold.
 */

/** The 31 primary result codes — what `SQLiteError.sqliteCode` holds. */
export const SQLITE_CODES = Object.freeze({
  OK: 0,
  ERROR: 1,
  INTERNAL: 2,
  PERM: 3,
  ABORT: 4,
  BUSY: 5,
  LOCKED: 6,
  NOMEM: 7,
  READONLY: 8,
  INTERRUPT: 9,
  IOERR: 10,
  CORRUPT: 11,
  NOTFOUND: 12,
  FULL: 13,
  CANTOPEN: 14,
  PROTOCOL: 15,
  EMPTY: 16,
  SCHEMA: 17,
  TOOBIG: 18,
  CONSTRAINT: 19,
  MISMATCH: 20,
  MISUSE: 21,
  NOLFS: 22,
  AUTH: 23,
  FORMAT: 24,
  RANGE: 25,
  NOTADB: 26,
  NOTICE: 27,
  WARNING: 28,
  ROW: 100,
  DONE: 101,
} as const);

/**
 * The 82 extended result codes — what `SQLiteError.sqliteExtendedCode` holds
 * when SQLite reports a subtype. No primary code is repeated here.
 */
export const SQLITE_EXTENDED_CODES = Object.freeze({
  ERROR_MISSING_COLLSEQ: 257,
  ERROR_RETRY: 513,
  ERROR_SNAPSHOT: 769,
  ERROR_RESERVESIZE: 1025,
  ERROR_KEY: 1281,
  ERROR_UNABLE: 1537,
  IOERR_READ: 266,
  IOERR_SHORT_READ: 522,
  IOERR_WRITE: 778,
  IOERR_FSYNC: 1034,
  IOERR_DIR_FSYNC: 1290,
  IOERR_TRUNCATE: 1546,
  IOERR_FSTAT: 1802,
  IOERR_UNLOCK: 2058,
  IOERR_RDLOCK: 2314,
  IOERR_DELETE: 2570,
  IOERR_BLOCKED: 2826,
  IOERR_NOMEM: 3082,
  IOERR_ACCESS: 3338,
  IOERR_CHECKRESERVEDLOCK: 3594,
  IOERR_LOCK: 3850,
  IOERR_CLOSE: 4106,
  IOERR_DIR_CLOSE: 4362,
  IOERR_SHMOPEN: 4618,
  IOERR_SHMSIZE: 4874,
  IOERR_SHMLOCK: 5130,
  IOERR_SHMMAP: 5386,
  IOERR_SEEK: 5642,
  IOERR_DELETE_NOENT: 5898,
  IOERR_MMAP: 6154,
  IOERR_GETTEMPPATH: 6410,
  IOERR_CONVPATH: 6666,
  IOERR_VNODE: 6922,
  IOERR_AUTH: 7178,
  IOERR_BEGIN_ATOMIC: 7434,
  IOERR_COMMIT_ATOMIC: 7690,
  IOERR_ROLLBACK_ATOMIC: 7946,
  IOERR_DATA: 8202,
  IOERR_CORRUPTFS: 8458,
  IOERR_IN_PAGE: 8714,
  IOERR_BADKEY: 8970,
  IOERR_CODEC: 9226,
  LOCKED_SHAREDCACHE: 262,
  LOCKED_VTAB: 518,
  BUSY_RECOVERY: 261,
  BUSY_SNAPSHOT: 517,
  BUSY_TIMEOUT: 773,
  CANTOPEN_NOTEMPDIR: 270,
  CANTOPEN_ISDIR: 526,
  CANTOPEN_FULLPATH: 782,
  CANTOPEN_CONVPATH: 1038,
  CANTOPEN_DIRTYWAL: 1294,
  CANTOPEN_SYMLINK: 1550,
  CORRUPT_VTAB: 267,
  CORRUPT_SEQUENCE: 523,
  CORRUPT_INDEX: 779,
  READONLY_RECOVERY: 264,
  READONLY_CANTLOCK: 520,
  READONLY_ROLLBACK: 776,
  READONLY_DBMOVED: 1032,
  READONLY_CANTINIT: 1288,
  READONLY_DIRECTORY: 1544,
  ABORT_ROLLBACK: 516,
  CONSTRAINT_CHECK: 275,
  CONSTRAINT_COMMITHOOK: 531,
  CONSTRAINT_FOREIGNKEY: 787,
  CONSTRAINT_FUNCTION: 1043,
  CONSTRAINT_NOTNULL: 1299,
  CONSTRAINT_PRIMARYKEY: 1555,
  CONSTRAINT_TRIGGER: 1811,
  CONSTRAINT_UNIQUE: 2067,
  CONSTRAINT_VTAB: 2323,
  CONSTRAINT_ROWID: 2579,
  CONSTRAINT_PINNED: 2835,
  CONSTRAINT_DATATYPE: 3091,
  NOTICE_RECOVER_WAL: 283,
  NOTICE_RECOVER_ROLLBACK: 539,
  NOTICE_RBU: 795,
  WARNING_AUTOINDEX: 284,
  AUTH_USER: 279,
  OK_LOAD_PERMANENTLY: 256,
  OK_SYMLINK: 512,
} as const);
