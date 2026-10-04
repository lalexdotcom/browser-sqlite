# `tx.savepoint()` and the transaction-control guard — design

**Date:** 2026-10-04 · **Status:** approved in chat section by section, spec under review · **Target:** rc.6 (`## [Unreleased]`) · **Branch:** `feat/tx-savepoint`

**Amended 2026-10-04 (plan):** `sqliteCode` is numeric — `SQLITE_CODES.AUTH`, 23 — wherever this spec writes `'AUTH'`. E19 is timing-dependent: `output()` creates its staging table after `sweepOnce()`, which may wait on a Web Lock, so a rollback issued while a load is open lands before or after the `CREATE`; the load either fails visibly or lands in the parent scope. The documented rule is to close a load before ending its savepoint, and B6 pins that shape. § 4 also allows transaction control while a statement is stepping: VACUUM runs its own BEGIN and COMMIT during its step, and a consumer's control statement is refused at its own prepare — or, cached, before its step — so it never reaches a step. `rollback({ release: false })` on a savepoint already rolled back and closed rejects with `SAVEPOINT_CLOSED`, since it promises an open savepoint (final review); `rollback()` with the default still resolves (E7).

Backlog entry "`tx.savepoint()` returning a rollback callback — for rc.6" (user, 2026-09-11). Raised while settling rc.5's savepoint rule (spec 2026-09-11, D1): three writes in one `try`, the third fails — the first two stay, as SQLite does for any statement error. A consumer who wants the three all-or-nothing without abandoning the whole transaction needs a nested block. This design gives it, and closes the hole it exposed: nothing stops a consumer from sending `BEGIN`, `COMMIT`, `SAVEPOINT` or `RELEASE` as SQL, inside a transaction or outside one.

**Amends** `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md`: its D8 (transaction-control statements are never wrapped in `__bsq_sp`, and a consumer may send them) is superseded by § 4 here; that spec gets a dated amendment pointing here.

---

## 1. Decisions (user, 2026-10-03 and 2026-10-04)

- **D1 — A handle, not a callback.** `tx.savepoint(name?)` resolves with `{ name, release(), rollback() }`. A callback form — `tx.savepoint(async (sp) => …)` with `sp` carrying the whole query API — was designed and dropped: its one real gain, knowing which branch issued which statement, concerns a rare use (concurrent branches opening savepoints in one transaction), while its cost lands on everyone (a second full query surface carrying `via`, the entry wait, the generator rule, T7, and a second new error code for a parent used while a child is open). A callback form can be added later on top of the handle without breaking anything; the reverse is not true.
- **D2 — `rollback({ release = true } = {})`.** By default `ROLLBACK TO` then `RELEASE`, and the handle is closed. With `release: false`, `ROLLBACK TO` alone: SQLite keeps the savepoint open with its changes undone, which is exactly the state of a savepoint just opened at that point — so the handle is simply open again, and no third state exists.
- **D3 — The name is optional.** Absent, the library generates `__bsq_sp_<n>`, `n` counting from 1 within each transaction. Given, it is refused with `INVALID_IDENTIFIER` when empty, when it contains NUL (both already `quoteIdent`'s refusals), when it starts with `__bsq_` (compared case-insensitively), or when a savepoint of that name is open on the stack (case-insensitively, as SQLite compares). A name used and closed may be reused. Every name reaches SQL through `quoteIdent`.
- **D4 — No `signal`, no `timeout`.** `tx.commit()` and `tx.rollback()` take none, and neither do `BEGIN`/`COMMIT`/`ROLLBACK` on the wire: cutting a control statement halfway leaves a state nobody can name. The three savepoint operations follow them. Their entry wait behind an abandoned write (spec 2026-09-11, R2) is bounded by the transaction's own `signal`/`timeout` only.
- **D5 — A savepoint still open when the transaction commits is committed with it.** SQLite's `COMMIT` closes every savepoint; the library sends no `RELEASE` of its own and logs no warning. The open handles turn to `TRANSACTION_CLOSED`, as every `tx` method does once the transaction has ended.
- **D6 — Refused in a `readOnly` transaction**, with `READ_ONLY_TRANSACTION`: nothing can be written there, so there is nothing to undo.
- **D7 — One new public error code, `SAVEPOINT_CLOSED`** (§ 6). Everything else reuses an existing code.
- **D8 — Transaction control is refused everywhere, by SQLite's authorizer.** `BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` sent as SQL are refused through `db.*` and through `tx` alike. Through the client they never worked: each `db.write` takes and returns its own lease, so `BEGIN` and `COMMIT` may land on different workers, and a connection left inside a transaction holds RESERVED, blocks every other writer and breaks the next `transaction()` on that worker — and a deferred `BEGIN` or a `SAVEPOINT` outside a transaction is what `OPFSWriteAheadVFS` refuses (spec 2026-09-15, A4). Inside `tx`, the library keeps a copy of the savepoint stack that a raw `RELEASE` would falsify, and SQLite offers no way to read the stack back. A check on each statement's leading keyword after SQLite has split the string was measured and is cheaper (TX-CONTROL-GUARD, `mem:measurements`); the user kept the authorizer: "on reste sur l'authorizer et on changera si nécessaire".
- **D9 — The consumer's savepoint operations are never cached** in the worker's statement cache. Generated names are unique within a transaction and given names may vary (`item_${id}`), so caching them would push the consumer's real statements out of a 32-entry LRU. The library's constant control statements (`BEGIN`, `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, the three `__bsq_sp` statements) stay cached.
- **D10 — Interleaved branches are documented, not detected.** Savepoints form a stack in the order of calls; two async branches that open and close savepoints in one transaction undo each other's writes. With handles, nothing tells the library which branch issued a statement, and the browser has no `AsyncLocalStorage`.

**Out of scope:** the callback form (D1); the Firefox `jspi` cost of the authorizer, which the `jspi` glue fix removes (`mem:follow-ups`, JSPI-SYNC-RELAYS); stating in the README that the library is opinionated (`mem:follow-ups`, the documentation pass).

## 2. What SQLite does, and this design relies on

- `SAVEPOINT x` pushes a marker; `ROLLBACK TO x` undoes everything since `x`, pops the savepoints above it and **keeps `x` open**; `RELEASE x` pops `x` and everything above it and writes nothing — the changes now belong to the level below, and only `COMMIT` makes anything durable. `COMMIT` and a full `ROLLBACK` close every savepoint.
- `ROLLBACK TO` and `RELEASE` address the **most recent** savepoint of that name, compared case-insensitively — hence D3's refusal of a name already open.
- An error that makes the connection leave the transaction (`ON CONFLICT ROLLBACK`, `IOERR`, `SQLITE_INTERRUPT` on a write) closes every savepoint (`sqlite3VdbeHalt`, read on 2026-09-11). An ordinary statement error (a constraint) undoes the statement alone and leaves the stack intact.
- Outside a transaction, `SAVEPOINT` opens one, deferred — the same as a bare `BEGIN`.
- **Open savepoints are not free.** Every page write walks the open savepoints, so leaving them open is quadratic: 1 000 / 4 000 / 16 000 savepoints of one insert each in one transaction took 1.4 / 4.6 / 20.6 ms released as they went, and 5.5 / 32.3 / 282.8 ms left open (SAVEPOINT-STACK, `mem:measurements`). That is the case for keeping `release()`, and for D2's default.

## 3. The public API

```ts
// src/api.ts
type SQLiteTransactionDB = SQLiteQueryAPI & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  savepoint: (name?: string) => Promise<SQLiteSavepoint>;
  readonly signal: AbortSignal;
};

type SQLiteSavepoint = {
  /** The name given, or the one generated (`__bsq_sp_<n>`) — what `db.debug` shows. */
  readonly name: string;
  release: () => Promise<void>;
  rollback: (options?: { release?: boolean }) => Promise<void>;
};
```

**Order.** The three operations take their place in the transaction's statement queue, as `commit()` does: issued without `await` before a `tx.write()`, `tx.savepoint()` still opens first. Each first waits for an abandoned write to end and be undone (R2 of the 2026-09-11 spec).

**States of a handle.**

| state | `release()` | `rollback()` |
|---|---|---|
| open | `RELEASE` → released | `ROLLBACK TO` + `RELEASE` → rolled back; with `{ release: false }`, `ROLLBACK TO` → open |
| released, by itself or by a parent's `RELEASE` | resolves, sends nothing | `SAVEPOINT_CLOSED`, `cause` = what released it |
| rolled back, by itself or by a parent's `ROLLBACK TO` | `SAVEPOINT_CLOSED`, `cause` = what rolled it back | resolves, sends nothing |
| transaction ended | `TRANSACTION_CLOSED` | `TRANSACTION_CLOSED` |

A method resolves only when what it promises is true: `release()` when the savepoint's changes are still in the transaction, `rollback()` when they are gone.

## 4. The guard — SQLite's authorizer

**Installed** in the worker after the open and its pragmas, on every connection: `sqlite.set_authorizer(db, fn)` with a **synchronous** `fn` — an `async` one would take wa-sqlite's `_async` relay. wa-sqlite keeps one authorizer per module (`pAsyncFlags` is module-scoped in its glue), which suits the one connection per worker that `open()` enforces.

**Refuses** `SQLITE_TRANSACTION` (22) and `SQLITE_SAVEPOINT` (32) — returning `SQLITE_DENY`, so the prepare fails with `SQLITE_AUTH` — unless the worker is executing a library control statement. Every other action is allowed, `PRAGMA` included. SQLite's parser decides what is control: `CASE … END`, `INSERT OR ROLLBACK`, `ON CONFLICT ROLLBACK`, a `CREATE TRIGGER … BEGIN …; END` body and `SELECT ';BEGIN'` are not, and a compound `INSERT …; SAVEPOINT y` is split before its second statement is prepared (probed 2026-10-03, TX-CONTROL-GUARD). `EXPLAIN BEGIN` is refused too; it runs nothing, so that costs nobody anything.

**The flag.** `SQLOptions` (`src/types/protocol.ts`) gains `control?: true`. It is set by `transaction.ts`'s `exec` for `BEGIN`, `BEGIN IMMEDIATE`, `COMMIT` and `ROLLBACK` — the teardown `ROLLBACK`, which goes to the raw worker rather than through `via`, included — and by the three savepoint operations. The worker raises it for the whole message, which also covers SQLite re-preparing a statement inside `step()` after a schema change. Its own `__bsq_sp` conclusion (`control()` in the `query` case) raises it for those statements alone and lowers it **before** the consumer's statement that shares the message.

**The cache.** A cache hit prepares nothing, so it never meets the authorizer: after the library's first `BEGIN IMMEDIATE`, a consumer's `db.write('BEGIN IMMEDIATE')` would find that entry and run. So an entry whose prepare made the authorizer see action 22 or 32 is marked as control, and a hit on a marked entry by a message without the flag is refused before `step()`, with the same error.

**The error.** The callback records the action and its argument; the worker rejects with `STATEMENT_FAILED`, `sqliteCode: 23`, and a message chosen by `sqlite3_get_autocommit`: outside a transaction it points to `db.transaction()`, inside one to `tx.savepoint()`. The library owns the connection, so `AUTH` comes from nothing else.

**Coverage.** Every statement of every client. A grep of `src/` finds transaction control in two places only, `transaction.ts` and the worker's `control()`, so nothing else needs the flag.

**Cost** (TX-CONTROL-GUARD): one callback per action of every prepare — 0.1-0.2 µs on Chromium, ~0.4 µs on Firefox `sync`/`async`, so +5 to +25 µs on a 50-column `SELECT`'s prepare and nothing on a cache hit; ~12 µs per callback on Firefox `jspi` until the glue fix (JSPI-SYNC-RELAYS), which brings it to +25 µs there too.

**Not new, to document:** in a compound string outside a transaction, `INSERT …; BEGIN` runs and commits the `INSERT` before the `BEGIN` is refused, as with any later statement that fails.

## 5. Client internals

**The stack copy** lives in `createTransaction`: a list of `{ name, state }` updated **at the call**, not at the reply. The queue runs statements in call order, so the copy follows exactly the order SQLite will see. Name checks (D3) run against it before anything is posted.

**One message per operation**, through `via`, with `control: true`, `uncached: true` (D9, a new `SQLOptions` field) and `internal: true` (so `db.debug` files it with the library's statements):

| operation | SQL |
|---|---|
| `tx.savepoint()` | `SAVEPOINT "x"` |
| `release()` | `RELEASE "x"` |
| `rollback()` | `ROLLBACK TO "x"; RELEASE "x"` |
| `rollback({ release: false })` | `ROLLBACK TO "x"` |

Through `via`, the message first concludes a pending `__bsq_sp`. That is correct because `__bsq_sp` is always the top of the stack (2026-09-11, D7): the consumer's `ROLLBACK TO` lands after the library's savepoint is resolved.

**A failed operation** calls `die(e)`, and the teardown sends its full `ROLLBACK` to the raw worker, as today. Nothing special in the worker.

**Each handle method reads `ending` first**, as every `tx` method does, and once it is set nothing reaches the worker. `queueWait` already rereads `ending` when a statement's turn comes (`if (ending) throw closedError(ending)`), so an operation queued behind `commit()` never sends a `SAVEPOINT` to a connection that has left its transaction.

**D8 of the 2026-09-11 spec goes.** `opensSavepoint`'s `!isTransactionControl(sql)` clause can no longer matter — a consumer's control statement is refused at prepare — and `isTransactionControl` is deleted with its unit tests. Its comment ("these statements are never compound") was false.

## 6. Error branches

**At the call, nothing posted:**

| # | situation | result |
|---|---|---|
| E1 | the transaction has ended — committed, rolled back or died | `TRANSACTION_CLOSED`, `cause` = the cause of death |
| E2 | `tx.savepoint()` in a `readOnly` transaction | `READ_ONLY_TRANSACTION` |
| E3 | name empty, not a string, containing NUL, or starting with `__bsq_` | `INVALID_IDENTIFIER` |
| E4 | name already open on the stack, case-insensitively | `INVALID_IDENTIFIER`, naming the open one |
| E5 | `rollback()` on a savepoint released, by itself or a parent | `SAVEPOINT_CLOSED`, `cause` |
| E6 | `release()` on a savepoint rolled back, by itself or a parent | `SAVEPOINT_CLOSED`, `cause` |
| E7 | `release()` on a released savepoint, `rollback()` on a rolled-back one | resolves, sends nothing |

**While waiting its turn:**

| # | situation | result |
|---|---|---|
| E8 | `tx.commit()` or `tx.rollback()` queued before the operation | `TRANSACTION_CLOSED` at its turn, nothing posted (`queueWait`) |
| E9 | the transaction dies — its `signal`, its `timeout`, `close()` — during the entry wait behind an abandoned write | rejects as a `tx` statement does today; the transaction is dead |
| E10 | the abandoned write ends with the connection out of its transaction | the transaction dies (D6 of 2026-09-11); `TRANSACTION_CLOSED` |

**Running:**

| # | situation | result |
|---|---|---|
| E11 | the pending `__bsq_sp` conclusion in the same message fails | the worker's full `ROLLBACK` (2026-09-11 amendment); the transaction dies |
| E12 | `SAVEPOINT`, `RELEASE` or `ROLLBACK TO` fails — a `RELEASE` after a successful `ROLLBACK TO` included | `die(e)`, then the teardown `ROLLBACK` |
| E13 | the authorizer refuses one of the library's own operations — a missing flag, our defect | `STATEMENT_FAILED` `AUTH`, then `die(e)`: the defect shows instead of passing silently |
| E14 | the worker crashes during the operation | the existing `WORKER_CRASHED` path; the transaction dies |

**Interactions:**

| # | situation | result |
|---|---|---|
| E15 | a write abandoned and caught inside a savepoint, then `sp.rollback()` | the message concludes `__bsq_sp` with `undo`, then `ROLLBACK TO`: everything since the savepoint is gone |
| E16 | an `ON CONFLICT ROLLBACK` write inside a savepoint | the connection leaves the transaction; the transaction dies (D6 of 2026-09-11); every handle → `TRANSACTION_CLOSED` |
| E17 | a generator left open, then `release()` or `rollback()` | waits its turn like `tx.commit()`, with the existing warning after a few seconds |
| E18 | a `bulkWrite()` still open when its savepoint closes | batches sent after the close land in the parent scope — the order-of-calls rule; documented |
| E19 | an `output()` open across a `sp.rollback()` | the rollback drops its staging table too, so the next batch or `close()` fails visibly (`no such table`) rather than writing wrongly; documented |

## 7. Tests

Each with the mutation that turns it red.

**Removed or rewritten:**

- `tests/unit/utils.test.ts`, the `isTransactionControl` block — deleted with the function.
- `tests/unit/transaction.test.ts`, the D8 test (a timed `tx.write('RELEASE u')` not wrapped) — deleted: the statement is refused now.
- `tests/browser/tx-savepoint.test.ts`, *a consumer's own savepoints*: T8 is rewritten with `tx.savepoint()` (B4 below). F2 — `BIG_INSERT; RELEASE u` abandoned — changes outcome: `RELEASE u` is refused at prepare, the abandoned write is undone by `__bsq_sp`, and the transaction goes on; the test asserts that. **Consequence:** the worker's `ROLLBACK` after a failed conclusion (the 2026-09-11 amendment) loses its only scenario a consumer can reach. The code stays — it is the defence against an I/O error during the conclusion — and gets a protocol-level test that posts a conclusion with no savepoint open, if the browser helpers reach the pool; otherwise it stays without a falsifier, and the user rules on it.

**Unit** — `tests/unit/transaction.test.ts`, fake worker. The fake worker records `control` and `uncached` beside the SQL it executes, or no assertion on its `executed` list describes the real worker.

- **U1** — T7 extended: the first message of `savepoint()`, `release()` and `rollback()` carries the pending `__bsq_sp` conclusion. Red: an operation calling the raw worker.
- **U2** — the three operations carry `control: true` and `uncached: true`; `BEGIN`, `COMMIT` and both `ROLLBACK`s carry `control: true`. Red: the flag dropped at any one site.
- **U3** — E1 to E8: the naming rules, handles closed by a parent with the right `cause`, an operation queued behind `commit()` posting nothing. Red: `queueWait` no longer rereading `ending`; the stack copy updated at the reply instead of the call.
- **U4** — E12: a failed operation calls `die`, and the teardown `ROLLBACK` carries no conclusion.
- **U5** — a `COMMIT` with open savepoints posts no `RELEASE`, and the handles turn to `TRANSACTION_CLOSED`.
- **U6** — generated names run `__bsq_sp_1` … `_n` within a transaction and restart at 1 in the next.

**Browser** — the shared suite, both engines, following the target.

- **B1** — nesting: `sp1`, a write, `sp2`, a write, `sp1.rollback()`: only the rows before `sp1` survive the commit. Red: `rollback()` addressing the child only.
- **B2** — `rollback({ release: false })`, a write, `rollback()` again, then `release()`. Red: the option ignored.
- **B3** — a loop with one savepoint per item and a `UNIQUE` violation on some: the failing items absent, the others present.
- **B4** — E15 (formerly T8): a write abandoned and caught inside a savepoint, then `sp.rollback()`. Red: the `__bsq_sp` conclusion sent after the `ROLLBACK TO`.
- **B5** — E16: `ON CONFLICT ROLLBACK` inside a savepoint turns the handles to `TRANSACTION_CLOSED`.
- **B6** — E19: an `output()` across a `sp.rollback()` fails visibly. Red: the load succeeding silently.
- **B7** — the authorizer. Outside a transaction, each refused with `STATEMENT_FAILED` `AUTH`: `BEGIN`; `BEGIN IMMEDIATE` **after a transaction has run**, so that it is cached; `SAVEPOINT x`; `COMMIT`; `END`; `INSERT …; BEGIN`, whose `INSERT` is kept. Allowed: `CASE … END`, `INSERT OR ROLLBACK`, `CREATE TRIGGER … BEGIN …; END`. Inside a transaction: `SAVEPOINT u`, `RELEASE u` and `ROLLBACK TO u` refused, and the transaction goes on when the error is caught. Red: the cache marking removed (the cached `BEGIN IMMEDIATE` passes); the authorizer removed.

**Before the merge:** `VFS_CAPABILITIES` does not change, but the worker protocol does — so the full matrix, beside `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm exec biome ci .` and `pnpm test:conformance`.

## 8. Documentation

- **`API.md`** — a `tx.savepoint()` section under `transaction()`: signature and `SQLiteSavepoint`, the states table in consumer terms, the naming rules, no `signal` (as for `commit()`/`rollback()`), an open savepoint committed with the transaction, the `readOnly` refusal. In *Inside a transaction*, beside the queue paragraph: savepoints are a stack in call order, interleaved branches undo each other, a `bulkWrite()` left open spills into the parent scope (E18), an `output()` across a rollback fails (E19). In `write()` and its siblings: transaction control is refused, use `transaction()` / `tx.savepoint()`, plus the compound-string property. In the error table: `SAVEPOINT_CLOSED`, and `STATEMENT_FAILED` with `sqliteCode: 23` for refused control.
- **`CHANGELOG.md`, `## [Unreleased]`**, through the `changelog-maintenance` skill — *Added*: `tx.savepoint()`, `SQLiteSavepoint`, `SAVEPOINT_CLOSED`. *Breaking*: `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` sent as SQL inside a transaction are refused; use `tx.savepoint()`. *Fixed*: `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT` and `RELEASE` through `db.write()` and its siblings are refused, where they used to leave a transaction open on a pooled connection.
- **`src/api.ts`** — JSDoc on `savepoint` and `SQLiteSavepoint`, public by construction; the `SQLiteErrorCode` union gains `SAVEPOINT_CLOSED`.
- **The 2026-09-11 spec** — a dated amendment: D8 superseded by § 4 here.
- **Before the merge, grep the tree for every phrasing of the old behaviour** — `D8`, `isTransactionControl`, "consumer's own savepoints", `SAVEPOINT` in docs and JSDoc (`mem:lessons`, the default-build review).
- **Serena memories** — `mem:architecture`: the authorizer invariant (the `control` flag is the only door, marked cache entries, savepoint operations uncached), the stack copy, D8 gone, T7 covering the three operations. `mem:follow-ups`: the rc.6 `tx.savepoint()` entry deleted. `mem:history`: a row at the merge.

## 9. Measurements behind this design

- **TX-CONTROL-GUARD** (`mem:measurements/transactions`, 2026-10-03): the authorizer against a check on each statement's head, three builds, two engines; SQLite's split of the tricky strings.
- **JSPI-SYNC-RELAYS** (`mem:measurements/statement-cache-and-perf`, 2026-10-04): why the authorizer costs ~12 µs per callback on Firefox `jspi`, and the one-line glue fix that removes it.
- **SAVEPOINT-STACK** (`mem:measurements/transactions`, 2026-10-03): open savepoints cost quadratically (§ 2).
