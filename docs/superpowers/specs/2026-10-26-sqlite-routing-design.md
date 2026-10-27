# SQLite decides read or write: `run()`, routing by verdict, and read workers that refuse writes

Date: 2026-10-26. Branch: `feat/sqlite-routing`. Background: `mem:follow-ups/sqlite-routing`. A breaking change, made deliberately before `1.0.0` stable (user: "quitte à faire un gros breaking, autant le faire avant la release de la v1 stable").

## Why

A write's `RETURNING` rows come back gathered whole through `write()`'s `result`; no write can be streamed, because `stream()`/`chunk()` only take reads. And which worker runs a statement is decided on the page by a regex (`isReadQuery` / `isWriteQuery` in `src/utils.ts`): an allowlisted opening keyword and no write keyword anywhere. Its false positives are accepted today (`SELECT 'INSERT'` and `EXPLAIN INSERT …` refused by `read()` and serialised through the writer), and it is the only thing that keeps a write off a read worker.

This workstream hands the decision to SQLite: a statement is prepared, `sqlite3_stmt_readonly` says whether it writes, and the routing follows. On that basis one method takes any statement, and the streaming methods take writes.

What streaming a write buys, and what it does not (verified in SQLite 3.53.0, the version the wa-sqlite pin builds): for an `INSERT`/`UPDATE`/`DELETE … RETURNING`, SQLite makes **every change during the first `step`**, storing the `RETURNING` rows in an ephemeral table (`trigger.c:1096`, opened by `OP_OpenEphemeral` at `build.c:257`), and only then rewinds that table to emit them (`build.c:178-189`). So the rows are buffered inside SQLite either way — in its page cache, spilling to a temporary file through the VFS under `temp_store = FILE`, the default. What streaming removes is the whole result gathered as JS objects on the page's main thread, which is where it costs most. It does not bring the first row sooner. No precise use case drives it (user).

## Decisions (user, 2026-10-26)

### The public surface

`SQLiteQueryAPI` (shared by the client and the transaction) becomes:

| method | takes | returns |
|---|---|---|
| `run<T>(…)` | any single statement | `Promise<{ rows: T[]; affected: number }>` |
| `stream<T>(…)` | any single statement | the async generator of rows, carrying `affected: Promise<number>` |
| `chunk<T>(…)` | any single statement | the async generator of chunks, carrying `affected: Promise<number>` |
| `all<T>(…)` | any single statement | `Promise<T[]>` |
| `first<T>(…)` | reads only | `Promise<T \| undefined>` |
| `read()`, `write()` | **removed** | — |

- Every method keeps both call forms (`(sql, params?, options?)` and `(query: SQLQuery, options?)`) and its options as today.
- `run()`'s result type replaces `SQLiteWriteResult<T>`; **the property is `rows`, not `result`** (user: closer to what users know, and more representative). `affected` is `total_changes()` after minus before, as the worker computes it today — 0 for a read.
- **No `lastInsertRowid`** (user, earlier): `RETURNING` covers it.
- **`all()` replaces `read()`** (user, 2026-10-27): `run()`'s rows alone, for any single statement — an `INSERT … RETURNING` included, which is why the name says nothing of reading. The name is node-sqlite3's `db.all()`, better-sqlite3's and `node:sqlite`'s `stmt.all()` (the method through which they return a `RETURNING`'s rows), and pairs with `first()`.
- **`first()` is the only read-only method**: it refuses a write with `NOT_A_READ_QUERY`. A method that may not deliver every row of a write does not take one: `first()` would write a thousand rows and return one — what better-sqlite3's and `node:sqlite`'s `.get()` do, and what the user rejected as misleading. `all()`, `run()`, `stream()`/`chunk()` deliver every row; a consumer who `break`s out of a `DELETE … RETURNING` has deleted everything, but that is the consumer's explicit act.
- **`stream()`/`chunk()`'s `affected`**: a property on the returned object, so `for await` keeps working unchanged. It resolves as soon as the worker knows the count — for a write, once the write has completed in the worker, before its first row is delivered (§ Streaming a write); at once for a read (0). If the statement fails, it rejects with the same error, and it is marked handled at creation so that nobody awaiting it raises no unhandled rejection. Declared type: `AsyncGenerator<T> & { affected: Promise<number> }` (the generator's type arguments stay as today).
- **`first()` gets no `affected`**: a property on a promise is awkward, and whoever wants the count calls `run()`.
- The name `run()` was chosen over `exec()`: in better-sqlite3 and `node:sqlite`, `exec()` runs several statements and returns nothing — exactly what this design refuses — while their `run()` returns `{ changes, lastInsertRowid }`; ours returns more (the rows), which surprises without misleading.

### Streaming a write: the worker finishes it first (user, 2026-10-26)

In autocommit, a `… RETURNING` statement commits at its `OP_Halt`, which SQLite places after the loop that emits the rows (`build.c:178-191`). Streamed as a read is, a write would therefore hold the writer, SQLite's write lock and the library's cross-tab write lock until the consumer has read its last row or abandoned it: a slow consumer would block every write of every tab, and no other worker would see the write meanwhile. Rejected (user): a write never depends on a consumer's pace.

So a statement that writes, reached through `stream()` or `chunk()`, **is stepped to its end in the worker before its first row is delivered**:

- The worker steps the statement to `SQLITE_DONE` (the write commits), keeping the encoded chunks, then sends them under the usual credit back-pressure.
- At that point the write is complete: the cross-tab write lock is released and the epoch published as `write()` does today, `affected` resolves, and the writer designation moves on. The worker stays leased until the delivery ends or is abandoned (one query in flight per worker still holds); how the scheduler releases the designation from a worker still leased is left to the builder, within its invariants.
- The page's memory stays bounded, which is what this workstream is for; the worker's JS memory now grows with the result of a streamed write (not of a streamed read).
- **Abandoning** (`break`, `return()`, the signal, the timeout) before the write completes behaves as an abandoned write does today (rolled back; inside a transaction, undone by the library's savepoint). After it completes, abandoning only stops the delivery: the write stays (Claude's call).
- Inside a transaction the same rule applies, so the transaction's connection is free for its next statement as soon as the write is done (Claude's call).
- **A write is never retried** (`readWithRetry`/`streamWithRetry` keep retrying reads only, before the first row), as today (Claude's call).

### Multi-statement strings are refused

Any SQL string that holds more than one statement is refused, before anything runs. Reason: a verdict before running needs every statement prepared first, and `CREATE TABLE t …; INSERT INTO t …` cannot prepare its second statement before the first ran.

- **Detection** (in the worker, at prepare): prepare the first statement, then prepare its tail (`pzTail`). A tail that yields no statement (whitespace, `;`, comments) is a single statement; a tail that yields a statement **or an error** is a refusal. The second statement need not be valid. This replaces `isSingleStatement` (`src/worker/worker.ts`), which compares texts and reads a statement followed by a comment as two.
- The refusal lives **in the prepare that executes**, not only in the verdict: a statement whose verdict is memoised, a transaction's statements, `first()` and the library's internal write path never ask for a verdict.
- What becomes dead and goes: the multi-statement binding shipped in rc.10 (each statement of anonymous `?` takes the next values — the worker's `cursor`), and the worker's multi-statement branch (`live`, the per-statement finalize).

### The classification

**A statement is a write when `sqlite3_stmt_readonly` returns 0, except an `EXPLAIN` or `EXPLAIN QUERY PLAN`, which is a read** (user, 2026-10-26). SQLite's documentation says `stmt_readonly` answers for an `EXPLAIN` what it would answer without the prefix, so `EXPLAIN INSERT …` reads 0 although it lists opcodes and changes nothing; `sqlite3_stmt_isexplain` (non-zero for both forms) corrects it. Both `Module._sqlite3_stmt_readonly` and `Module._sqlite3_stmt_isexplain` are exported by the three builds (checked 2026-10-26); `sqlite-api.js` wraps neither.

What `stmt_readonly` computes (SQLite 3.53.0, `vdbeaux.c:878-907`): 0 when the program holds an `OP_Transaction` that opens a write transaction on any database, `temp` included, or an `OP_Checkpoint`, `OP_Vacuum` or `OP_JournalMode`; 1 otherwise. The cases where that differs from "changes something" are listed in Open, item 1.

**Measured 2026-10-27** (Node 24, wa-sqlite's `sync` build at the pin, `:memory:` with a table, an index, `temp` and an attached database; every statement of Open item 1, and the 65 names of `PRAGMA pragma_list` in three forms — bare, `= 0`, `(arg)`): the statements answer as the inventory says. Among the pragmas, only `journal_mode`, `wal_checkpoint` and `incremental_vacuum` (every form) and the assignments of `user_version`, `application_id`, `schema_version` answer 0. Everything else answers 1, including **`PRAGMA optimize`, which writes** (it runs `ANALYZE` from a nested program the outer statement does not show), `auto_vacuum = …` (measured writing on 2026-10-01, per `src/utils.ts`) and every connection setting. `readonly` + `isexplain` cost 6.8 ns a pair (n = 1 000 000). The authorizer, already installed, reports each pragma as `SQLITE_PRAGMA` with its name and value parsed by SQLite (`cache_size`/`10`, `table_info`/`t`, `journal_mode`/none, `user_version`/`3` on `aux`), and `ATTACH` (24) and `DETACH` (25); a table-valued pragma (`pragma_table_info('t')`) is a `SELECT` on a read-only virtual table and reports no `SQLITE_PRAGMA`.

**So `stmt_readonly` does not classify pragmas. The rule (proposed by Claude after the measurement, confirmed by the user on 2026-10-27):**

1. **A pragma** (seen by the authorizer at prepare): classified by `src/utils.ts`'s lists — moved where the worker imports them, one source — applied to the name and value SQLite reports: a value with a name outside `INTROSPECTION_PRAGMAS` is a write; a name in `BARE_WRITING_PRAGMAS` is a write without a value too; anything else is a read. That is rc.10's behaviour, without a regex on the text.
2. **`ATTACH`, `DETACH`**: writes, as the regex makes them today.
3. **Transaction control**: refused by the authorizer, unchanged.
4. **Everything else**: `isexplain` non-zero is a read; otherwise `stmt_readonly`.

The classification is computed at prepare and kept with the cached statement, as `controlSql` is, since the authorizer does not run on a cache hit. It lives in the worker only: the worker needs it for its own guard (`first()`), and a page-side copy would mean a second reading of the SQL, by regex, for one round trip saved per distinct pragma (Claude's recommendation, accepted with the rule). Connection settings go to the writer, as with `write()` today; that divergence is not new and not addressed.

### Routing by verdict

Applies to `run()`, `all()`, `stream()` and `chunk()` on the client. (`first()` and transactions: below.)

1. **The memo.** The client keeps a `Map` from SQL text to verdict. A known verdict sends the statement straight to today's path: the read queue, or the write lock then the writer queue.
2. **An unknown verdict asks a worker first.** The request waits on the client **at the head of every queue, writers included**, and goes out at the first event that proves a worker reachable:
   - a lease returned (a free worker), or
   - a transaction's statement finished (a worker held by a transaction, with no query in flight — the transport knows it for certain).

   No guess, no broadcast. A worker that streams or steps is never asked: the client cannot know when it reaches a point where it may call SQLite again (user, 2026-10-26: "ça me paraît bien").

   Ordering (Claude's calls): a worker free at the call takes the verdict at once; waiting verdicts are their own FIFO, served before the read and write queues; a statement whose verdict is memoised does not wait behind a pending verdict — it joins its own queue directly.

   **On a free worker the verdict takes a short lease** from the scheduler (a third kind, served first), so it goes through `acquireInstrumented`'s ordinary path: the barrier's bookkeeping (`seen`) stays per lease, and since a free worker is never the designated writer, the verdict cannot land on it (Claude's call). On a worker held by a transaction there is no lease — the transaction holds it — and the worker-side serialisation below is what protects it.
3. **The worker prepares the statement, calls `sqlite3_stmt_readonly`, checks the tail, and answers** `read`, `write`, or `refused` (multi-statement). It runs nothing.
4. **The statement then joins the ordinary queue of its kind.** A refusal rejects the call at once, without any queue.

**The verdict on the worker.**

- It travels on its own message type, apart from the query transport: outside `pool.ts`'s `WORKER_BUSY` reuse guard and outside `inTransaction`.
- **One SQLite call at a time in the worker**: a verdict and a query are serialised there. Required on the `async`/`jspi` builds, where a transaction's next statement can arrive while the verdict's prepare is suspended; re-entering the wasm module mid-call corrupts it under Asyncify and trips wa-sqlite's shared `retryOps` (#341).
- **The statement cache:** on a free worker the verdict uses the cache normally (one query per worker still holds). On a worker held by a transaction it is read-only: a cached statement is consulted without being touched; otherwise the statement is prepared outside the cache and finalised. An insertion there could evict, and so finalise, a statement the transaction still uses. Nothing guarantees that the worker which gave the verdict runs the statement, so the verdict's prepare is a real cost, not one moved earlier.
- **A failed prepare is not a verdict.** A failure says nothing about the statement's kind, and routing it to the writer would let a long read block writes (user). So:
  - on a free worker: apply the barrier through the verdict's lease, then prepare once more. A second failure is a real error, returned straight to the caller (`STATEMENT_FAILED`, as the query would have given);
  - on a worker held by a transaction (a snapshot, where no barrier applies): ask again, of a free worker.

  Why the failure path should be rare (read in SQLite 3.53.0): a name that does not resolve sets `checkSchema` (`build.c:453` no such table, `resolve.c:797` no such column, and cases in `insert.c`, `update.c`, `select.c`, `trigger.c`); `sqlite3Prepare` then re-reads the schema cookie from the file (`prepare.c:802`, `schemaIsValid`) and `sqlite3LockAndPrepare` recompiles once (`prepare.c:857-866`). The cookie is read through the VFS, so a VFS whose page view lags fools it — `OPFSWriteAheadVFS`'s `isolateForRead()`, `mem:measurements/writeahead` — which is exactly the case the barrier covers.
- The barrier stays where it is (on every lease); the verdict knows it only on its failure path.

**The memo** (Claude's call, user: "on peut le prévoir, et faire des mesures après implémentation si on veut le supprimer ensuite"):

- One per client, an LRU of 256 entries; texts longer than 4 KiB are not memoised, which also bounds the bytes. Verdicts `read`, `write` and `refused` are memoised; errors are not.
- No invalidation: a verdict depends on the text alone — an `INSERT` is a write and a `SELECT` a read whatever the schema; the multi-statement refusal is textual. **To be pinned by a test**, not assumed.
- Estimated, not measured: a hit costs a hash and a compare, about a microsecond, against ~0.2 ms for a worker round trip (`mem:measurements/step`: a one-row `first()` costs 0.21-0.27 ms); a few dozen bytes per entry plus the text when it is not a literal the caller already holds. The pathological case is SQL with values written into its text: each call is a new key, pays its verdict and pushes others out — the bound protects memory, not speed, as for the statement cache.
- **Measured after implementation**, to keep or remove it.

### `first()`

It asks for no verdict: it goes straight to the read queue, and the worker classifies the statement (§ The classification) after the prepare and before any `step` — cache hits included — refusing a write with `NOT_A_READ_QUERY`. No round trip. The regex `isReadQuery` and the client-side `assertReadable` go. (This is the follow-up "read workers refuse writes themselves", opened by the user on 2026-10-04.)

### Transactions

One connection, so no routing: `tx.run()`, `tx.all()`, `tx.stream()`, `tx.chunk()` run on the transaction's worker; `tx.first()` refuses a write through the same worker-side check.

`src/transaction.ts` uses `isWriteQuery` twice today, on the page, before posting; neither keeps the regex (Claude's calls — keeping it contradicts the user's "SQLite decides", and savepointing every statement that carries its own signal would make reads pay what D4 of spec 2026-09-11 spared them):

- **A `readOnly` transaction** refuses a write with `READ_ONLY_TRANSACTION`, as today: the message says the transaction is read-only, and the worker refuses a statement its classification calls a write, before any `step`. Nothing else guards it — connections open `SQLITE_OPEN_READWRITE` and no `query_only` is set.
- **The library's savepoint** (`opensSavepoint`, spec 2026-09-11 R1) needs the kind **on the page, before posting**: the whole abandon structure (`driving`, the abort race, `via(true)`) is built around it. So, for a statement carrying its own signal or timeout only, the transaction asks for the kind at the statement's turn in its queue: from the client's memo, or else as a verdict from **its own worker** (idle at that turn, since the queue serialises the statements). Revised on 2026-10-27, while planning, from a first version where the worker decided after the prepare: that one would have made the page learn after the fact whether a savepoint was opened, and rebuilt the abandon structure around it.

**`tx.stream()`/`tx.chunk()` take writes again**: the path that runs a generator's write inside the library's savepoint (`drainToEnd`, the `st.savepointed` branches of `chunkSource`/`releasing` in `src/transaction.ts`) was kept for this workstream and comes back into use, with tests (they were removed by `fix/tx-api-consistency`). **`tx.stream()`/`tx.chunk()` take writes again**: the path that runs a generator's write inside the library's savepoint (`drainToEnd`, the `st.savepointed` branches of `chunkSource`/`releasing` in `src/transaction.ts`) was kept for this workstream and comes back into use, with tests (they were removed by `fix/tx-api-consistency`).

## Cost of a verdict

One worker round trip (~0.2 ms) plus a prepare when the asked worker does not hold the statement in its cache (0.017-0.21 ms per simple statement by build, Chromium `async` dearest; `mem:measurements/statement-cache-and-perf`, 2026-08-28). With the memo, paid once per distinct statement per client; in steady state, nothing.

## Open — to measure, then decide with the user, before the implementation that depends on it

1. **Where `stmt_readonly` and "changes something" disagree.** Inventory from SQLite's documentation and source (2026-10-26). **Measured on 2026-10-27; the result and the rule it leads to, confirmed by the user, are in § The classification.** Closed; the inventory below stays as the list of cases the tests pin.

   Answered 1 although they change something:
   - **Transaction control**: `BEGIN` (deferred), `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` answer 1 (documentation); `BEGIN IMMEDIATE`/`EXCLUSIVE` answer 0. Covered: the authorizer refuses them at prepare, so at the verdict too, with `AUTH` — to pin by a test.
   - **`ATTACH`, `DETACH`** answer 1 (documentation): on one read worker, the pool's connections diverge.
   - **Pragmas that set connection state without writing the file**: `PRAGMA cache_size(10)` answers 1 and runs on a read-only connection (measured 2026-10-09); likely too `foreign_keys=`, `busy_timeout`, `synchronous=`, `temp_store=`, `query_only=`, `recursive_triggers=` and the like. Same divergence.
   - Application-defined functions and virtual tables with side effects (the documentation's caveat): not applicable — the library registers none and offers no way to.

   Answered 0 although they change nothing:
   - **`EXPLAIN` of a write**: settled by `stmt_isexplain` (§ The classification).
   - **`PRAGMA journal_mode`, the bare query**: SQLite emits `OP_JournalMode` for the query form too (`pragma.c:759-768`), so it answers 0. `read('PRAGMA journal_mode')` passes today: refusing it would be a regression. Other read-form pragmas may share it — measure every pragma the lists in `src/utils.ts` name, in both forms.
   - A no-op `UPDATE`, `CREATE TABLE IF NOT EXISTS` on an existing table: unknowable without running, and the error points the safe way. Accepted.

   Answered 0 rightly, with a divergence anyway: **`CREATE TEMP TABLE` and writes to `temp`** open a write transaction on `temp`, go to the writer, and exist on its connection alone — as with `write()` today; not new, not addressed here.

   Candidate rule for the connection-state statements, not decided: the worker's authorizer (already installed for transaction control) marks `SQLITE_ATTACH`, `SQLITE_DETACH` and a `SQLITE_PRAGMA` carrying a value, and those are routed as writes — today's behaviour, where the regex sends them to `write()`. **Constraint:** the introspection pragmas with an argument (`PRAGMA table_info(t)`…) stay reads, as shipped in rc.10. **The authorizer alone cannot honour it:** it reports `PRAGMA table_info(t)` and `PRAGMA cache_size(10)` alike (name and argument), so the rule needs the pragma name lists that `src/utils.ts` holds today (`INTROSPECTION_PRAGMAS`, `WRITING_PRAGMAS`, `BARE_WRITING_PRAGMAS`) on the worker side. And the authorizer does not run on a statement-cache hit, so the mark is stored with the cached statement, as `controlSql` is. **The plan stops after this measurement and reports to the user before building the classification that depends on it.**
2. **The library's internal statements.** The barrier is a multi-statement string on VFS with a catch-up pragma (`barrierSqlFor`, `src/epochs.ts`: `PRAGMA x=1; <barrier>; PRAGMA x=0`). Every internal statement (barrier, `__bsq_sp` control, the transaction's `exec`, `bulkWrite`/`output`) is either made single, or exempted from the refusal by an explicit internal flag — never by text.
3. **The error code of the multi-statement refusal.** Claude's call, to confirm: a new code, `MULTIPLE_STATEMENTS`.

## Goals

- `run()` takes any single statement and returns `{ rows, affected }`; `all()` returns its rows; `stream()`/`chunk()` take writes and expose `affected`; `first()` alone refuses writes.
- SQLite decides read or write; the regex is gone from routing.
- A write never runs on a read worker, whatever path it takes (verdict, memo, `first()`, transaction).
- Multi-statement strings are refused before anything runs.

## Non-goals

- `lastInsertRowid`.
- Streaming that saves SQLite-side memory (impossible, see Why), or that brings the first row of a write sooner.
- `temp_store` defaults (`mem:follow-ups/temp-store-anycontext`, separate).
- Asking a worker that streams or steps for a verdict (it would need the worker to announce that it waits; later, if a measurement asks for it).
- A verdict memo shared between clients.

## Anti-goals — a failure even if `run()` works

- A write that runs on a read worker, or a read that runs on the writer while writes wait.
- A read routed to the writer because its verdict failed.
- A verdict's prepare that finalises or resets a statement a query or a transaction still uses.
- Two SQLite calls in flight in one worker.
- Part of a multi-statement string executed.
- The pool's connections diverging (a pragma or an `ATTACH` applied to one read worker).
- A regression of rc.10's introspection pragmas as reads.
- A transaction's statement left waiting behind a verdict for longer than that verdict's prepare.
- A write lock (cross-tab or SQLite's) held while a consumer reads a write's rows.

## Breaking changes (CHANGELOG `### Breaking`, commits marked `!` with a `BREAKING CHANGE:` footer)

- `write()` is removed; `run()` replaces it.
- `read()` is removed; `all()` replaces it and also takes writes.
- The write result's `result` is renamed `rows`.
- Multi-statement strings are refused, and their parameter binding (rc.10) is removed.

The migration is written in the CHANGELOG entry (no stable version yet, `mem:conventions`). `API.md` and `README.md` are updated; `VFS.md` if a per-VFS fact changes.

## Left to the builder

- Message names and shapes of the verdict on the transport, and where the memo lives.
- How the scheduler holds the verdict request at the head (it stays pure and unit-tested in Node).
- How the worker serialises its SQLite calls.
- How the worker sends `affected` ahead of a write's first chunk, and how it keeps a streamed write's chunks until they are delivered.
- Whether `sql`'s numbered `?N` placeholders stay (harmless once one statement is the rule) or simplify.
- Whether `db.debug` shows verdicts.
- The internal write path `bulkWrite`/`output` use in place of the public `write()`, as long as it asks for no verdict and still takes one lease per batch.

## Verification

- The delivery gate (`node scripts/hook-gate.ts delivery --run`).
- The matrix on GitHub before the merge: the branch touches `src/pool.ts`, `src/transaction.ts`, `src/worker/` and the scheduler (`mem:conventions`, § What runs where).
- After implementation: the memo measured (with and without), and the verdict's cost per build.
