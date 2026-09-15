# A failed statement says why — design

**Status:** approved in chat 2026-09-14, section by section; **amended 2026-09-15** (D8, D9).
**Branch:** `feat/statement-errors`, from `main` after `42d587d`.
**Triage:** reliability, so rc.5 (`mem:state`, the user's rule of 2026-09-09) — except D4, a
feature the user put in scope explicitly.

**Amendment of 2026-09-15 (user).** After Task 1 was implemented with one table: the result
codes are split into `SQLITE_CODES` (primary) and `SQLITE_EXTENDED_CODES` (D8), and
`sqliteExtendedCode` is absent when SQLite reports no subtype (D9). §3, §4, §5.3, §6 and §7
below are written to the amended design.

**Amended again 2026-09-15 after the final review:** `sqliteCode` is carried only for
wa-sqlite's `SQLiteError` (`sqliteCodeOf`), and the worker stamps at three sites.

## 1. The problem

A statement SQLite refuses reaches the consumer as a plain `Error`. Its `code` is undefined, it
has no `sqliteCode`, and the only thing telling a constraint violation apart from a full disk is
the message. Seen in TX-M1 (`mem:measurements`, 2026-09-10): a caught INSERT failing with
*database or disk is full* arrived with neither `code` nor `sqliteCode`.

**The worker is not where the code is lost.** Its three error sites — a query, an open and a
delete — already copy a numeric `code` into `sqliteCode` on the wire. That premise was too
broad: before the final review they copied ANY numeric `code`, not only wa-sqlite's own —
§5.2 narrows this to `sqliteCodeOf`. The client drops it:

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

## 2. Decisions (user, 2026-09-14, amended 2026-09-15)

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
- **D6: the result codes are exported.** Chosen by the user over exporting nothing and linking
  SQLite's list. wa-sqlite's own constants are not reachable by a consumer, since they are
  bundled, and are incomplete (§4). The shape is D8.
- **D7: no extended code at open or delete.** When `sqlite3_open_v2` itself fails there is no
  connection to ask. When a `pragmas` entry fails there is one, but an open failure is a
  configuration failure, and the primary code with the message diagnoses it. Adding it later is
  one more site in the same place.
- **D8 (2026-09-15): two tables, one per field — `SQLITE_CODES` (the 31 primary codes) and
  `SQLITE_EXTENDED_CODES` (the 82 extended codes).** The family is tested on `sqliteCode`
  against `SQLITE_CODES`, the subtype on `sqliteExtendedCode` against `SQLITE_EXTENDED_CODES`.
  It makes the one easy mistake visible in its own spelling: `err.sqliteCode ===
  SQLITE_CODES.CONSTRAINT_UNIQUE` is always false and nothing would flag it, since both fields
  are typed `number`. The tables do not overlap: no primary code is repeated in the extended
  one.
- **D9 (2026-09-15): `sqliteExtendedCode` is absent when SQLite reports no subtype.**
  `sqlite3_extended_errcode` returns the primary code again for a failure that has no subtype
  (`FULL`, a syntax error, `NOTADB`). With D8, that value is in neither table's sense a subtype.
  `sqliteCode` already carries it, so nothing is lost. **Absent, not `null`**: every optional
  field of `SQLiteError` is absent when it does not apply. `undefined` then means "no subtype"
  or "not a statement" (open, delete). Nobody needs to tell those apart, since
  `undefined === SQLITE_EXTENDED_CODES.X` is false in both. **The client normalises, not the
  worker:** `statementError` keeps the extended code when it differs from `sqliteCode`. So a
  wrong read (a 0 from a successful call) stays visible instead of being filtered out.

## 3. The contract

`SQLiteErrorCode` gains `STATEMENT_FAILED`. `SQLiteError` gains
`readonly sqliteExtendedCode?: number`, present only when a statement SQLite ran failed **with a
subtype**. When present, `sqliteExtendedCode & 0xff === sqliteCode`. The constructor accepts it
as an option, like `sqliteCode`.

| Failure | `code` | `sqliteCode` | `sqliteExtendedCode` |
|---|---|---|---|
| Statement, lock conflict (5/6) | `BUSY` (unchanged) | 5 or 6 | new, when a subtype: 517, 262… |
| Statement, any other SQLite code | **`STATEMENT_FAILED`** (was a plain `Error`) | primary (new) | new, when a subtype: 2067, 787… |
| Open, lock conflict | `BUSY` (unchanged) | 5 or 6 | — |
| Open, any other SQLite code | `WORKER_CRASHED` (unchanged) | primary (new) | — |
| `deleteDatabase`, as open | as open | as open | — |
| Worker failure with no SQLite code (a JS exception) | plain `Error`, unchanged | — | — |

Examples: a UNIQUE violation gives 19 and 2067; a full disk gives 13 and no subtype.

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

## 4. `SQLITE_CODES` and `SQLITE_EXTENDED_CODES`

- **Content: the result codes of SQLite 3.53.0, and nothing else.** `SQLITE_CODES` holds the 31
  primary codes, `OK`, `ROW` and `DONE` included. `SQLITE_EXTENDED_CODES` holds the 82 extended
  ones. Open flags, datatypes and every other constant are left out. The rule is mechanical, so
  no judgment decides which codes deserve a place.
- **Keys drop the prefix**: `SQLITE_CODES.CONSTRAINT` (19), `SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE`
  (2067). An extended key begins with its family's primary key.
- **Form: two `as const` objects, frozen.** `sqliteCode` and `sqliteExtendedCode` stay typed
  `number`, not a literal union: a later SQLite may add codes.
- **Source: transcribed from `src/sqlite.h.in`, the source of `sqlite3.h`, at SQLite's tag
  `version-3.53.0`.** That is the SQLite of the vendored wa-sqlite, v1.1.2, whose `package.json`
  still reads 1.1.1 because upstream did not bump it. The evidence is the source-id read from
  the wasm, `2026-04-09 11:41:38 4525003a53a7fc63ca75`: the tag's `manifest.uuid` begins with
  the same hash. The comment names the version and the date checked, as `FEATURE_SUPPORT`
  does. wa-sqlite's `sqlite-constants.js` cannot serve as the source: it holds the 31 primary
  codes and 33 extended ones, mostly `IOERR_*` and `CONSTRAINT_*`, and no `BUSY_*`,
  `LOCKED_*`, `CANTOPEN_*`, `CORRUPT_*` or `READONLY_*`.
- **Location:** `src/sqlite-codes.ts`, both exported by name from `src/index.ts`.

## 5. Mechanism

### 5.1 The worker reads the extended code where the statement fails

`sqlite3_extended_errcode(db)` reports the connection's **most recent** API call. Read while the
`error` reply is built, it is wrong in at least one real case. When concluding a savepoint fails,
the worker issues a full `ROLLBACK` before replying (the `query` case, spec 2026-09-11, D5
amendment). That `ROLLBACK` succeeds and resets the connection's code to 0. `settle`'s `reset`
and `finalize` also write it, with results that depend on SQLite's internals.

So `query` stamps the code on wa-sqlite's error the first time it is caught, as a property
`extendedCode` assigned with `??=`, so that nothing later overwrites it. It stamps only an error
for which `sqliteCodeOf` reads a code (§5.2) — wa-sqlite's own `SQLiteError`, never any numeric
`code`. Three sites cover every failure:

- **in `run`, around `bind_collection` and `step`**, before any cleanup. `SQLITE_INTERRUPT` is
  excluded: it breaks out of the loop and is never reported;
- **the fresh branch's own inner catch**, for a later statement's prepare failure in a
  multi-statement string — a syntax error or a missing collation reached before that string's
  `finally` can finalize anything;
- **at `query` level, the outer catch** — the uncacheable branch's own prepare failures, which
  leave wa-sqlite's own `statements()` generator with no catch of ours in between (it runs only
  `sqlite3_errmsg` and `sqlite3_free` before the error leaves it, neither touching
  `sqlite3_extended_errcode(db)`), so this is the only site that stamps them.

Savepoint statements go through `query`, so they are covered with no extra site.

The export is `module._sqlite3_extended_errcode`, present in all three builds' glue (checked
2026-09-14). It is declared in `src/wa-sqlite.d.ts` beside `_sqlite3_stmt_status`, by the same
reasoning: declared, not cast, so the count of structural `any` does not move.

The worker sends what SQLite reported, subtype or not. D9's normalisation is the client's.

### 5.2 The wire

The `error` message in `src/types.ts` gains `sqliteExtendedCode?: number`. The worker's `query`
catch copies it from `extendedCode` beside `sqliteCode`. `open-error` does not gain it (D7).

**Final review.** All three reply sites — `open-error`, the `query` case's `error`, and the
`delete` path's `error` — carry `sqliteCode` only through `sqliteCodeOf` (`src/worker/sqlite-code.ts`),
never from any numeric `code` on the thrown value. Without it, the open chain's
`navigator.storage.getDirectory()` and `AccessHandlePoolVFS`'s `#acquireAccessHandles()`, and the
delete path's rethrown `DOMException`s, would leak a legacy numeric `code` as if it were SQLite's
— e.g. `SecurityError`'s 18 reading as `SQLITE_CODES.TOOBIG`. `sqliteCodeOf` recognizes only
wa-sqlite's own `SQLiteError`, the class `src/sqlite-api.js` exports beside `Factory`.

### 5.3 The client — two pure functions, exported for the unit project

- **The statement mapper** replaces `workerError`'s body:
  1. `errorCode`, if present, is used as today;
  2. `sqliteCode` 5 or 6 gives `BUSY`;
  3. any other `sqliteCode` gives `STATEMENT_FAILED`;
  4. otherwise the plain `Error` stays.

  In cases 2 and 3 the error carries `sqliteCode`, and `sqliteExtendedCode` when it differs
  from `sqliteCode` (D9).
- **The startup mapper**, `busyFromCode(data) ?? WORKER_CRASHED` carrying `sqliteCode`, is
  called by both `pool.ts`'s `open-error` case and `delete.ts`'s `error` case. Each site is then
  one call, and one unit test covers both.

`BUSY_CODES` and `busyFromCode` keep their single home in `pool.ts`, and so does D9's rule, in
one helper both mappers use.

## 6. Tests

### Unit (Node)

- The statement mapper: all four branches, both codes carried where present, and the extended
  code dropped when it equals `sqliteCode`, for `STATEMENT_FAILED` and `BUSY` alike.
- The startup mapper: `BUSY`, `WORKER_CRASHED` with `sqliteCode`, `WORKER_CRASHED` without; and,
  final review, D7 as a property of `startupError` itself — an input carrying
  `sqliteExtendedCode` still produces none, because `startupError` rebuilds `busyFromCode`'s
  argument from `message`/`cause`/`sqliteCode` alone rather than forwarding it whole.
- `SQLiteError`: `sqliteExtendedCode` set and unset.
- `sqliteCodeOf` (final review, `src/worker/sqlite-code.ts`): reads the code off wa-sqlite's own
  `SQLiteError`; returns undefined for a `DOMException` carrying the same numeric `code` shape
  (asserting its `.code` first so the exclusion means something), a plain object, and a plain
  `Error`.
- The two tables:
  - every name shared with wa-sqlite's `sqlite-constants.js` has the same value there;
  - no primary sits in the extended table and no extended code in the primary one;
  - every extended code's low byte is the value of its family, the primary key its name begins
    with;
  - 31 and 82 entries, both frozen.

### Browser — the shared suite, both engines, on `sync`, `async` and `jspi`

The builds matter because each has its own export of the extended-code function.

- **Constraints**, one parameterised test through `write()`: UNIQUE (19/2067), foreign key with
  `foreign_keys` on (19/787), NOT NULL (19/1299). Each asserts `STATEMENT_FAILED`, both codes,
  and the message unchanged.
- **The `prepare` path, through `read()`**: a missing collation, `SELECT 'a' = 'b' COLLATE
  nosuch`, gives 1/257 (`ERROR_MISSING_COLLSEQ`). It is the prepare failure that has a
  subtype, and so the one that can falsify a prepare-level stamp (checked on SQLite 3.46 with
  Python's `sqlite3`, 2026-09-15: raised at prepare, extended 257). This single-statement form
  takes the fresh branch's own inner catch, which stamps first (`??=`), so it falsifies only the
  removal of BOTH prepare-level stamps together.
- **The same failure, fresh then uncacheable (final review)**: the same SQL as a later statement
  in a multi-statement string, `SELECT 1; SELECT 'a' = 'b' COLLATE nosuch`, read twice. The first
  run takes the fresh branch and marks the string uncacheable; the second prepares through
  wa-sqlite's own `statements()` generator, where only `query`'s outer catch stamps. This is what
  falsifies the outer stamp alone: drop it and the second run's `sqliteExtendedCode` is
  undefined while the first run's is unaffected.
- **A syntax error through `read()`**: `STATEMENT_FAILED`, 1, and no `sqliteExtendedCode` —
  D9's absence, end to end.
- **`SQLITE_FULL` inside a transaction**, TX-M1's scenario (`PRAGMA max_page_count` then an
  oversized INSERT, caught): 13, no subtype. This is the observation that opened the follow-up.
- **A failed savepoint conclusion** (the `RELEASE u` case of spec 2026-09-11): `STATEMENT_FAILED`,
  1, no subtype. **This is the test that falsifies a late read**: after the `ROLLBACK` a late
  read finds 0, which differs from 1 and is therefore kept by D9 — the assertion of absence
  fails.
- **`bulkWrite`**: a constraint violated in a batch gives `BULK_WRITE_FAILED` whose `cause` is a
  `STATEMENT_FAILED` carrying both codes.
- **Open**, on an `opfs-path` VFS, over an OPFS file filled with arbitrary bytes. **With** a
  `pragmas` entry the open fails: `WORKER_CRASHED`, `sqliteCode` 26 (`NOTADB`). **Without**
  one, the open is lazy and the first query fails: `STATEMENT_FAILED`, 26, no subtype. Both are
  asserted, because a consumer will meet both.

## 7. Documentation

- **`API.md`, Error handling:**
  - the opening sentence covers SQL errors;
  - a `STATEMENT_FAILED` row;
  - the `WORKER_CRASHED` row mentions `sqliteCode` at open, and the `BUSY` row mentions
    `sqliteExtendedCode`;
  - a short paragraph on both fields and both tables, saying which to test against which, that
    a failure without a subtype has no `sqliteExtendedCode`, and linking
    <https://sqlite.org/rescode.html>;
  - the `switch` example gains `err.sqliteExtendedCode === SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE`.
- **`CHANGELOG.md`, Unreleased.** *Breaking*: the three points of §3. *Added*:
  `sqliteExtendedCode`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`, and `sqliteCode` on
  `WORKER_CRASHED` at open and delete.
- **Memories, at the closure:** delete the `mem:follow-ups` entry "`SQLITE_FULL` reaches the
  client with neither `code` nor `sqliteCode`", and update `errors.ts` in `mem:architecture` and
  `mem:state`.

## 8. Out of scope

- Named codes per result-code family (D1). They can be added over `STATEMENT_FAILED` later.
- The extended code at open and delete (D7).
- A worker failure that carries no SQLite code: a JS exception stays a plain `Error`.
- Literal-union types for `sqliteCode` and `sqliteExtendedCode` (§4).
