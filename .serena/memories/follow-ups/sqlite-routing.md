# Follow-up — SQLite decides read or write: `run()`, routing by verdict, and read workers that refuse writes

**Status: IN PROGRESS** — designed with the user on 2026-10-26; spec committed on `feat/sqlite-routing`, plan next (2026-10-27).

Part of `mem:follow-ups`, opened 2026-10-26 (user). Large and breaking, done before `1.0.0` stable on purpose (user: "quitte à faire un gros breaking, autant le faire avant la release de la v1 stable"); the user had first deferred it until the small workstreams were closed, then took it up the same day.

**The design is the spec, not this memory:** `docs/superpowers/specs/2026-10-26-sqlite-routing-design.md`. Every decision, its reason and who made it (user or "Claude's call") is there; read it, not a summary. In one line: `run()` returns `{ rows, affected }` for any single statement; `stream()`/`chunk()` take writes and carry `affected: Promise<number>`; `read()`/`first()` refuse writes worker-side; `write()` is removed; multi-statement strings are refused; an unknown statement's kind comes from a verdict (`sqlite3_stmt_readonly`, `EXPLAIN` read via `sqlite3_stmt_isexplain`) asked of a reachable worker, memoised per client; a streamed write is stepped to its end in the worker before its rows are delivered.

## What the design conversation established that the spec states as fact — kept here for its sources

- **`RETURNING` changes all happen at the first `step`; the commit comes after the last row** (SQLite 3.53.0, `trigger.c:1096`, `build.c:178-191`, `OP_Halt` after the `ResultRow` loop). Why the user chose to finish a streamed write in the worker first (option b).
- **A name that does not resolve at prepare re-reads the schema cookie and recompiles once** (`prepare.c:802` `schemaIsValid`, `prepare.c:857-866`); fooled only by a VFS whose page view lags (`OPFSWriteAheadVFS`, `mem:measurements/writeahead`), which the barrier covers.
- **`stmt_readonly`'s rule** (`vdbeaux.c:878-907`): 0 for a write `OP_Transaction` on any database (temp included), `OP_Checkpoint`, `OP_Vacuum`, `OP_JournalMode`. Consequence found 2026-10-26: **`PRAGMA journal_mode` (the bare query) answers 0** (`pragma.c:759-768`), a regression for `read()` unless handled.
- `Module._sqlite3_stmt_readonly` and `Module._sqlite3_stmt_isexplain` are exported by the three builds (checked 2026-10-26).

## Unmeasured, in the spec's Open list

What `stmt_readonly` answers for `ATTACH`/`DETACH` (documented 1), the connection-state pragmas (`PRAGMA cache_size(10)` = 1, measured 2026-10-09; the others likely), every pragma of `src/utils.ts`'s lists in both forms, and the cost per prepare. The plan stops after that measurement and reports to the user.

## Dead code kept for this workstream (user, 2026-10-26)

Since `tx.chunk()`/`tx.stream()` refuse writes (`fix/tx-api-consistency`), the path that ran a generator's write inside the library's savepoint (`drainToEnd`, the `st.savepointed` branches of `chunkSource`/`releasing` in `src/transaction.ts`) is unreachable; kept because this workstream reuses it. Its tests were removed with the refusal and come back with it.
