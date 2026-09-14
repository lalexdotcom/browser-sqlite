# A failed statement says why — design

**Status:** approved in chat 2026-09-14, section by section; not yet planned.
**Branch:** `feat/statement-errors`, from `main` after `42d587d`.
**Triage:** reliability, so rc.5 (`mem:state`, the user's rule of 2026-09-09) — except D4, a
feature the user put in scope explicitly.

## 1. The problem

A statement SQLite refuses reaches the consumer as a plain `Error`. Its `code` is undefined, it
has no `sqliteCode`, and the only thing telling a constraint violation apart from a full disk is
the message. Seen in TX-M1 (`mem:measurements`, 2026-09-10): a caught INSERT failing with
*database or disk is full* arrived with neither `code` nor `sqliteCode`.

**The worker is not where the code is lost.** Its three error sites — a query, an open and a
delete — already copy wa-sqlite's numeric `code` into `sqliteCode` on the wire. The client drops
it:

- `workerError` in `src/pool.ts` builds a `SQLiteError` only for `errorCode` (no producer today)
  and for `sqliteCode` 5 or 6 (`busyFromCode`). Everything else — syntax (1), constraint (19),
  `FULL` (13), `READONLY` (8), `IOERR` (10) — becomes `new Error(message)`.
- The `open-error` case in `src/pool.ts` and the `error` case in `src/delete.ts` build
  `WORKER_CRASHED` without passing `sqliteCode` on.

`API.md` states that errors raised by this library are `SQLiteError` instances and is silent on
what a failed statement produces. No test asserts the class of a SQL error.

**Only primary codes exist today.** Neither this library nor wa-sqlite calls
`sqlite3_extended_result_codes`, so a UNIQUE violation and a foreign-key violation both report
19.

## 2. Decisions (user, 2026-09-14)

- **D1: one new code for every statement failure that is not a lock conflict**, with the
  numeric result code on `sqliteCode`. Chosen over one named code per result-code family
  (`CONSTRAINT`, `FULL`, …), which would grow the union by a dozen codes mirrored from SQLite,
  and over a plain `Error` carrying `sqliteCode`, which leaves `switch (err.code)` unusable.
  `BUSY` stays the one specialised code, because it alone drives behaviour (the read retry).
- **D2: scope.** A failed statement gets the new code. An open or a delete that SQLite fails
  keeps `WORKER_CRASHED`, still true since the slot dies, but now carries `sqliteCode`. Chosen
  over changing the code at open too, which would break a consumer catching `WORKER_CRASHED` at
  startup and would require revisiting what the supervisor and `failClient` conclude from a
  death.
- **D3: the name is `STATEMENT_FAILED`.** It follows `BULK_WRITE_FAILED`, and "statement" is the
  documentation's word throughout. `SQL_ERROR` was set aside as one letter from `SQLITE_ERROR`,
  SQLite's name for result code 1 alone. `QUERY_FAILED` was set aside because "query" means a
  read in this API (`NOT_A_READ_QUERY`), while a constraint violated by a `write()` is the
  typical case.
- **D4: the extended result code ships in rc.5.** Recommended for rc.6 by the triage rule, since
  it is a new capability rather than a lost one. The user put it in scope.
- **D5: the extended code gets its own field, `sqliteExtendedCode`; `sqliteCode` stays
  primary.** `sqliteCode` has been published since rc.4. `BUSY`'s documentation promises 5 or 6
  on it, and the read retry discriminates on it. Making it extended would break a published
  `sqliteCode === 5` as soon as SQLite reported 517.
- **D6: the result codes are exported, as `SQLITE_CODES`.** Chosen by the user over exporting
  nothing and linking SQLite's list. wa-sqlite's own constants are not reachable by a consumer,
  since they are bundled, and are incomplete (§4).
- **D7: no extended code at open or delete.** When `sqlite3_open_v2` itself fails there is no
  connection to ask. When a `pragmas` entry fails there is one, but an open failure is a
  configuration failure, and the primary code with the message diagnoses it. Adding it later is
  one more site in the same place.

## 3. The contract

`SQLiteErrorCode` gains `STATEMENT_FAILED`. `SQLiteError` gains
`readonly sqliteExtendedCode?: number`, present only on a statement SQLite ran, where
`sqliteExtendedCode & 0xff === sqliteCode` always holds. The constructor accepts it as an option,
like `sqliteCode`.

| Failure | `code` | `sqliteCode` | `sqliteExtendedCode` |
|---|---|---|---|
| Statement, lock conflict (5/6) | `BUSY` (unchanged) | 5 or 6 | new: 5, 517, 262… |
| Statement, any other SQLite code | **`STATEMENT_FAILED`** (was a plain `Error`) | primary (new) | extended (new) |
| Open, lock conflict | `BUSY` (unchanged) | 5 or 6 | — |
| Open, any other SQLite code | `WORKER_CRASHED` (unchanged) | primary (new) | — |
| `deleteDatabase`, as open | as open | as open | — |
| Worker failure with no SQLite code (a JS exception) | plain `Error`, unchanged | — | — |

**Unchanged:** `message`, which stays SQLite's text (`UNIQUE constraint failed: users.email`);
`cause`; and the read retry, which still keys on `BUSY` carrying a `sqliteCode`.

**Breaking, with a CHANGELOG entry:**

- a SQL error is no longer a plain `Error` but a `SQLiteError`;
- its `name` changes from `'Error'` to `'STATEMENT_FAILED'`, which stack traces and logs show;
- a `catch` treating `instanceof SQLiteError` as "the library's error, not my statement's" now
  catches SQL errors too.

Nothing in `src/` depends on any of the three. Every `instanceof SQLiteError` test there
(`client.ts`, twice, and `pool.ts`) also tests for one specific code: `OPERATION_TIMEOUT`,
`BUSY` or `WORKER_CRASHED`.

**`bulkWrite`/`output` need nothing.** `SQLiteBulkWriteError` already keeps the batch's failure
as `cause`, so `err.cause` will be the `STATEMENT_FAILED`.

## 4. `SQLITE_CODES`

- **Content: every result code of SQLite 3.53.0, primary and extended, and nothing else.** That
  includes `OK`, `ROW` and `DONE`. Open flags, datatypes and every other constant are left out.
  The rule is mechanical, so no judgment decides which codes deserve a place.
- **Keys drop the prefix**: `SQLITE_CODES.CONSTRAINT_UNIQUE` (2067), `SQLITE_CODES.BUSY` (5). In
  use: `err.code === 'BUSY' && err.sqliteCode === SQLITE_CODES.BUSY`.
- **Form: an `as const` object, frozen.** `sqliteCode` and `sqliteExtendedCode` stay typed
  `number`, not a literal union: a later SQLite may add codes.
- **Source: transcribed from `src/sqlite.h.in`, the source of `sqlite3.h`, at SQLite's tag
  `version-3.53.0`**, the version bundled by wa-sqlite 1.1.1 (source-id
  `2026-04-09 11:41:38 4525003a53a7fc63ca75`, read from the wasm; the tag's `manifest.uuid`
  begins with the same hash). 31 primary codes and 82 extended ones. The comment
  names the version and the date checked, as `FEATURE_SUPPORT` does. wa-sqlite's
  `sqlite-constants.js` cannot serve as the source: it holds the 31 primary codes and 33
  extended ones, mostly `IOERR_*` and `CONSTRAINT_*`, and no `BUSY_*`, `LOCKED_*`,
  `CANTOPEN_*`, `CORRUPT_*` or `READONLY_*`.
- **Location:** `src/sqlite-codes.ts`, exported by name from `src/index.ts`.

## 5. Mechanism

### 5.1 The worker reads the extended code where the statement fails

`sqlite3_extended_errcode(db)` reports the connection's **most recent** API call. Read while the
`error` reply is built, it is wrong in at least one real case. When concluding a savepoint fails,
the worker issues a full `ROLLBACK` before replying (the `query` case, spec 2026-09-11, D5
amendment). That `ROLLBACK` succeeds and resets the connection's code to 0. `settle`'s `reset`
and `finalize` also write it, with results that depend on SQLite's internals.

So `query` stamps the code on wa-sqlite's error the first time it is caught, as a property
`extendedCode` assigned with `??=`, so that nothing later overwrites it. It stamps only an error
whose `code` is a number. Two sites cover every failure:

- **in `run`, around `bind_collection` and `step`**, before any cleanup. `SQLITE_INTERRUPT` is
  excluded: it breaks out of the loop and is never reported;
- **at `query` level, for `prepare` failures** (syntax errors), where no SQL runs between the
  failure and the `catch`.

Savepoint statements go through `query`, so they are covered with no extra site.

The export is `module._sqlite3_extended_errcode`, present in all three builds' glue (checked
2026-09-14). It is declared in `src/wa-sqlite.d.ts` beside `_sqlite3_stmt_status`, by the same
reasoning: declared, not cast, so the count of structural `any` does not move.

### 5.2 The wire

The `error` message in `src/types.ts` gains `sqliteExtendedCode?: number`. The worker's `query`
catch copies it from `extendedCode` beside `sqliteCode`. `open-error` does not gain it (D7).

### 5.3 The client — two pure functions, exported for the unit project

- **The statement mapper** replaces `workerError`'s body:
  1. `errorCode`, if present, is used as today;
  2. `sqliteCode` 5 or 6 gives `BUSY` with both codes;
  3. any other `sqliteCode` gives `STATEMENT_FAILED` with both codes;
  4. otherwise the plain `Error` stays.
- **The startup mapper**, `busyFromCode(data) ?? WORKER_CRASHED` carrying `sqliteCode`, is
  called by both `pool.ts`'s `open-error` case and `delete.ts`'s `error` case. Each site is then
  one call, and one unit test covers both.

`BUSY_CODES` and `busyFromCode` keep their single home in `pool.ts`.

## 6. Tests

### Unit (Node)

- The statement mapper: all four branches, both codes carried where present.
- The startup mapper: `BUSY`, `WORKER_CRASHED` with `sqliteCode`, `WORKER_CRASHED` without.
- `SQLiteError`: `sqliteExtendedCode` set and unset.
- `SQLITE_CODES`: every name it shares with wa-sqlite's `sqlite-constants.js` has the same value
  there; every extended code `& 0xff` is a primary code of the list; the object is frozen.

### Browser — the shared suite, both engines, on `sync` and `async`

The builds matter because each has its own export of the extended-code function. `jspi` is
tested where the engine has it.

- **Constraints**, one parameterised test through `write()`: UNIQUE (19/2067), foreign key with
  `foreign_keys` on (19/787), NOT NULL (19/1299). Each asserts `STATEMENT_FAILED`, both codes,
  and the message unchanged.
- **Syntax through `read()`**, the `prepare` path: `STATEMENT_FAILED`, 1/1.
- **`SQLITE_FULL` inside a transaction**, TX-M1's scenario (`PRAGMA max_page_count` then an
  oversized INSERT, caught): 13/13. This is the observation that opened the follow-up.
- **A failed savepoint conclusion** (the `RELEASE u` case of spec 2026-09-11). It asserts that
  `sqliteExtendedCode` is present and `& 0xff === sqliteCode`. **This is the test that
  falsifies a late read**: after the `ROLLBACK` a late read would find 0.
- **`bulkWrite`**: a constraint violated in a batch gives `BULK_WRITE_FAILED` whose `cause` is a
  `STATEMENT_FAILED` carrying both codes.
- **Open**, on an `opfs-path` VFS, over an OPFS file filled with arbitrary bytes. **With** a
  `pragmas` entry the open fails: `WORKER_CRASHED`, `sqliteCode` 26 (`NOTADB`). **Without**
  one, the open is lazy and the first query fails: `STATEMENT_FAILED`, 26. Both are asserted,
  because a consumer will meet both.

## 7. Documentation

- **`API.md`, Error handling:**
  - the opening sentence covers SQL errors;
  - a `STATEMENT_FAILED` row;
  - the `WORKER_CRASHED` row mentions `sqliteCode` at open, and the `BUSY` row mentions
    `sqliteExtendedCode`;
  - a short paragraph on both fields and `SQLITE_CODES`, linking
    <https://sqlite.org/rescode.html>;
  - the `switch` example gains `err.sqliteExtendedCode === SQLITE_CODES.CONSTRAINT_UNIQUE`.
- **`CHANGELOG.md`, Unreleased.** *Breaking*: the three points of §3. *Added*:
  `sqliteExtendedCode`, `SQLITE_CODES`, and `sqliteCode` on `WORKER_CRASHED` at open and delete.
- **Memories, at the closure:** delete the `mem:follow-ups` entry "`SQLITE_FULL` reaches the
  client with neither `code` nor `sqliteCode`", and update `errors.ts` in `mem:architecture` and
  `mem:state`.

## 8. Out of scope

- Named codes per result-code family (D1). They can be added over `STATEMENT_FAILED` later.
- The extended code at open and delete (D7).
- A worker failure that carries no SQLite code: a JS exception stays a plain `Error`.
- Literal-union types for `sqliteCode` and `sqliteExtendedCode` (§4).
