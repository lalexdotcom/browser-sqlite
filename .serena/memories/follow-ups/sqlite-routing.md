# Follow-up — SQLite decides read or write: `run()`, routing by diagnosis, and read workers that refuse writes

**Status: OPEN** — designed in outline by the user; large and breaking, after the small workstreams (2026-10-26).

Part of `mem:follow-ups`, opened 2026-10-26 (user). **A large, breaking change, deferred by the user until the small workstreams are closed** ("ça vaut peut-être le coup de le faire maintenant, mais j'aimerais clôturer les petits chantiers avant"). The user is still thinking about the breaking side.

## Why: streaming the rows a write returns

Since `fix/tx-api-consistency` (2026-10-26) `tx.read()`/`tx.first()`/`tx.chunk()`/`tx.stream()` refuse a write, as the client's do; a write's `RETURNING` rows come back through `write()`/`tx.write()`'s `result`, gathered whole — no write can be streamed. The user rejected `lastInsertRowid` on `SQLiteWriteResult` ("ce n'est qu'un cas particulier" of `RETURNING`, single-row only); the question is how to stream a write's return. Prior art surveyed 2026-10-26: better-sqlite3, `node:sqlite` and expo-sqlite read `RETURNING` through their row methods (`all()`/`get()`), the method choosing the shape; libsql, D1 and pg return rows and counts from one call.

## The user's design (2026-10-26)

- **One method that takes any SQL, `run()` or `exec()`, instead of `read()`/`write()`**, with automatic routing; `stream()` and `chunk()` use the same routing, so a write's `RETURNING` can be streamed.
- **SQLite decides read or write, not the client's regex** — the `sqlite3_stmt_readonly` entry below.
- **The query goes to the first free worker, which diagnoses it:** it runs it if it may, else refuses it with its kind (read or write) and the orchestrator puts it in the right queue.
- **The writer refuses a read too when writes are queued** (user): it rejects the read with its diagnosis, so the read waits in the read queue and the writes are not delayed behind it.
- **Multi-statement strings are refused as part of this workstream** (user). Reason: a verdict before running needs every statement prepared first, and `CREATE TABLE t …; INSERT INTO t …` cannot prepare its second statement before the first ran.

Open:
- **A verdict memo on the client**, `Map` SQL → read/write, so only a statement's first run pays the diagnosis round trip (Claude's proposal). The user's objection: the statement cache is in the worker, so it is a second index. Its case: a worker's verdict helps no other worker, and the client is what picks the queue. Bound and eviction undecided.
- Whether `read()` and `write()` stay as explicit assertions beside `run()`, or go.
- Inside a transaction there is one connection: `tx.run()` needs no routing.
- **Dead code kept for this workstream (user, 2026-10-26):** since `tx.chunk()`/`tx.stream()` refuse writes, the path that ran a generator's write inside the library's savepoint (`drainToEnd`, the `st.savepointed` branches of `chunkSource`/`releasing` in `src/transaction.ts`) is unreachable. Kept rather than deleted, since a streamed write through `tx.run()`/`tx.stream()` would need it again; its tests were removed with the refusal (`fix/tx-api-consistency`) and would come back with it.

## Read workers refuse writes themselves, with `sqlite3_stmt_readonly` — not started (user, 2026-10-04)

Moved here from `mem:follow-ups` on 2026-10-26; the diagnosis above is built on it.

Today the one-writer invariant rests on the client's routing regex (`isReadQuery`: an allowlisted opening keyword and no write keyword anywhere). Proposed by the user after the transaction-control guard (`feat/tx-savepoint`): the worker checks each prepared statement on a read lease — cache hits included — before its first `step`, so a misrouted write can never run on a read worker. **The primitive is `sqlite3_stmt_readonly`, not the authorizer**: one wasm export call per prepared statement, SQLite deciding, no per-action JS callback (so no Firefox `jspi` relay cost); `Module._sqlite3_stmt_readonly` is exported by all three builds (checked 2026-10-04), not wrapped by `sqlite-api.js`. It complements the routing, which picks the worker before any prepare; it could then let the regex relax its false positives (`SELECT 'INSERT'` serialized through the writer, `db.read("SELECT … 'BEGIN'")` refused). The read methods refuse a write on the client and, since `fix/tx-api-consistency` (2026-10-26), inside a transaction too (`assertReadable`, `NOT_A_READ_QUERY`).

**Known (2026-10-09, wa-sqlite's SQLite 3.53.0):** `PRAGMA cache_size(10)` answers `stmt_readonly` = 1 and runs on a read-only connection, though it changes the connection — so `stmt_readonly` alone would admit setting pragmas. **Measure first:** what `stmt_readonly` answers for the other statements that change only connection state — `ATTACH`, `DETACH`, `PRAGMA x = y`, `CREATE TEMP TABLE` — which would make one read worker diverge from the others; those may need the authorizer (`SQLITE_ATTACH`, `SQLITE_DETACH`, `SQLITE_PRAGMA` with a value) or the client rule kept. And the cost per prepare.
