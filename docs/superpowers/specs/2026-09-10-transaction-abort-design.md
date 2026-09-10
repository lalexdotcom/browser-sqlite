# A write that is abandoned abandons its transaction — design

**Status:** approved in chat 2026-09-10, not yet planned.
**Branch:** `fix/tx-statement-timeout`, as its second step. The first step — a per-statement
`timeout` inside `transaction()`, which used to be silently ignored — is already committed on
the branch; this design is what restoring it exposed.

**One breaking change**, for a released behaviour: `signal` on `transaction()` shipped in
`1.0.0-rc.4`, and a statement the callback issues after that signal fired rejects there with
`signal.reason`. It will reject with `TRANSACTION_ABORTED` (§3, R3). Everything else here is
either a fix or touches options that have never been released (`timeout`, the transaction's
abandonment by `close()`).

## 1. The problem, measured

**SQLite rolls the whole transaction back when a write is interrupted.** The documentation of
[`sqlite3_interrupt`](https://www.sqlite.org/c3ref/interrupt.html) says so for an INSERT,
UPDATE or DELETE inside an explicit transaction; [*Response To Errors Within A
Transaction*](https://www.sqlite.org/lang_transaction.html) adds that `SQLITE_FULL`,
`SQLITE_IOERR` and `SQLITE_NOMEM` may do the same, and that `sqlite3_get_autocommit()` is how
an application tells which happened.

**Nothing in this library observes it.** `src/worker/worker.ts` catches `SQLITE_INTERRUPT`
out of `step()` and breaks, deliberately, so the query ends with `done` — the client is never
told that the connection has left its transaction. The callback then goes on issuing
statements into a connection in autocommit mode.

**Measured on 2026-09-10**, in this container, three runs per case on Chromium and Firefox,
every case identical across runs and engines. Inside a transaction: `INSERT (1)`, then an
`INSERT … SELECT` of 1 000 000 rows cut by its own `signal` after 30 ms, then `INSERT (2)`.
Throwaway probes and raw outputs: `.scratchpad/probe-autocommit/` (not versioned).

| Build | Callback | What happened | Worker evicted |
|---|---|---|---|
| `async` (`OPFSAdaptiveVFS`, `OPFSWriteAheadVFS`, `MemoryVFS`), and `sync` under cross-origin isolation (`MemoryVFS`) | catches | `INSERT (1)` is gone inside the callback: SQLite rolled back. `INSERT (2)` runs in autocommit and **lands durably**. `COMMIT` fails with *cannot commit - no transaction is active*, the transaction rejects — with row 2 in the database. | yes, every run |
| same | does not catch | Rows correct, but the fallback `ROLLBACK` fails for the same reason and `onPoisoned` evicts the worker. | yes, every run |
| `sync` without isolation (`OPFSWriteAheadVFS`, `MemoryVFS`) | catches | Nothing can cut the running `step()`: the write completes, its 1 000 000 rows stay in the transaction and are **committed**, although the caller received a rejection. | no |
| same | does not catch | Clean rollback. | no |

**On a memory VFS an eviction destroys the database.** After the uncaught case on
`MemoryVFS` the next read fails with `no such table: t` — a table created and committed before
the transaction. The respawned worker opens a fresh, empty memory database.

Four defects, one mechanism: atomicity broken silently; a worker evicted on every interrupted
write in a transaction, caught or not; committed data lost on a memory VFS; and, where a step
cannot be cut, a rejected write whose effects commit anyway.

## 2. The decision (user, 2026-09-10)

**A write that is abandoned abandons its transaction, on every build.** It is the only rule
that is uniform: where a step can be cut SQLite has already decided it, and where it cannot,
the library decides the same thing on purpose. A rejection then always means *no effect*.

**The alternative was designed and refused:** never cut a write inside a transaction, let it
finish, and undo it with a savepoint, so the transaction survives. It keeps what preceded the
write, and pays for it with the purpose of `timeout`: an abandoned write would wait for its own
end, with the write lock held, and then be thrown away — costlier than no timeout at all. A
consumer would rationally never set one. It would also add a `SAVEPOINT`/`RELEASE` round trip
to every write in every transaction. **Do not re-propose it without an answer to that.**

## 3. The rules

**R1 — How a transaction dies.** Three causes exist and are unchanged: its own `signal`, its
own `timeout`, `close()`. Two are new:

- **A write statement is abandoned**: any statement issued through the transaction whose SQL
  `isWriteQuery()` classifies as a write, rejected by its OWN `signal` or `timeout` — whichever
  method issued it (`tx.read()`, `tx.first()`, `tx.chunk()` and `tx.stream()` do not refuse a
  write, so the method cannot be the discriminator). **This includes a signal already aborted
  at the call**, where the statement never reached the worker: the rule stays one sentence
  instead of depending on when the abort landed (user, 2026-09-10). `isWriteQuery()` errs
  toward the writer, which here errs toward dying — the safe direction.
- **`tx.bulkWrite()` or `tx.output()` is abandoned** by its own `signal` or `timeout`. Their
  abort lands between batches and cuts no step, but they are writes and follow the rule.
- **The connection left the transaction by itself**, as the worker reports after any
  statement (§4) — `SQLITE_FULL`, `SQLITE_IOERR`, `SQLITE_NOMEM`, or anything else that ends
  it.

**R2 — Outside, the caller of `db.transaction()` receives the cause of death**, directly:

| Cause | `db.transaction()` rejects with |
|---|---|
| its own `signal` | `signal.reason`, verbatim |
| its own `timeout` | `OPERATION_TIMEOUT` |
| `close()` | `CLIENT_CLOSED` |
| an abandoned write | that write's own rejection value — `signal.reason` verbatim, or `OPERATION_TIMEOUT` naming `write()`, `bulkWrite()`… |
| the connection left the transaction | the error of the statement after which it did; if that statement succeeded, a `TRANSACTION_ABORTED` naming it |

A caller testing `e.code === 'OPERATION_TIMEOUT'` around `db.transaction()` catches a timeout
whether it was the transaction's or a statement's.

**R3 — Inside, three statements are distinguished.**

- **The statement that caused the death** rejects with its own value, unchanged — the
  ownership rule of `docs/superpowers/specs/2026-09-07-uniform-timeout-design.md` holds.
- **A statement in flight when the transaction dies** of another cause rejects with the cause,
  as today (pinned by *aborts a statement that carries a signal of its own* in
  `tests/unit/transaction.test.ts`).
- **Every statement issued after the death rejects with `TRANSACTION_ABORTED`**, carrying the
  cause as `cause`, **whatever the cause**, before any round trip: `read`, `write`, `first`,
  `commit()`, the first `next()` of `chunk`/`stream`, and `bulkWrite`/`output` at the call —
  where `readOnly`'s refusal already sits, for the same reason. One test inside the callback,
  `e.code === 'TRANSACTION_ABORTED'`, means *this transaction is gone, stop*. This is the
  breaking change: after the transaction's own `signal` those statements rejected with
  `signal.reason`.

This is not one error per remaining line of the callback. An uncaught rejection ends the
callback at the first `await`; `TRANSACTION_ABORTED` is reached only by a callback that caught
the first error and went on, or that was waiting on something other than the database when an
outside abort landed. It is the only way to stop a callback JavaScript cannot interrupt.

**R4 — `tx.rollback()` on a dead transaction resolves, without reaching the worker.** The
consumer is asking for the state they are already in. The transaction's own teardown performs
the SQL `ROLLBACK`, and only if the connection is still in a transaction (R6). Not reaching the
worker matters beyond politeness: after an abandonment the lease goes back to the pool, and
today `rollback()` is the one statement that carries no guard — an abandoned callback calling
it could send `ROLLBACK` to a connection by then serving someone else. **That hazard is read
from the code, not measured**; this rule closes it either way.

**R5 — Uniform across builds.** On the `sync` build without isolation the abandoned write ran
to its end and its effects sit in the open transaction; the teardown rolls them back like any
other. Latency still differs by build — nothing returns sooner than the running `step()` there —
but the outcome does not.

**R6 — No eviction when SQLite already rolled back.** The teardown sends `ROLLBACK` only when
the connection reports a transaction open. A `ROLLBACK` that fails on a connection that still
had one is evicted exactly as today.

**R7 — An abandoned READ does not kill the transaction.** A caught read timeout lets the
callback continue and commit, as step 1 established. **Premise to measure first** (§8, M1):
SQLite's `sqlite3VdbeHalt` rolls back on `SQLITE_INTERRUPT` only for a statement that is not
read-only. If the measurement contradicts it, this design is amended before any code.

## 4. The mechanism

**The worker reports the connection's state on every query reply.** `done` and `error` gain
`inTransaction: boolean`, computed as `sqlite.get_autocommit(db) === 0` after the query ends —
including the `error` the `closing` path posts. `get_autocommit` is exported by all three
wa-sqlite builds (checked in `dist/` on 2026-09-10). One WASM call per query; no new message.

**`pool.ts` records the last reported value on the `PoolWorker`**, updated on the `done` or
`error` of the current `callId`. **It is connection state, not availability**: nothing
schedules on it, and the field's comment must say so where someone would reach for it — the
rule in `mem:architecture` that forbids an availability flag on the worker object is about
the scheduler, and this must not read as a breach of it, nor become one.

**The transaction owns an internal `AbortController`, merged into its signal**, whose reason
is the cause of death. Aborting it is how every new cause joins the existing machinery: the
race against the callback rejects the transaction with the cause (R2), and a statement in
flight rejects with it (R3, second bullet). The entry of every statement then checks the
transaction's signal before anything else and throws `TRANSACTION_ABORTED` with
`cause: signal.reason` — which is what extends R3's third bullet to the three existing causes.

**Where the new causes are detected:**

- **An abandoned write**, in `withSignal`'s `settled` and in `releasing`'s `finally` — the two
  places a statement ends (`mem:architecture`). Both already know the statement's own signal
  (the `withDeadline` result); they need its SQL, which becomes a parameter. Rejected with the
  own signal's reason, SQL a write: the transaction dies with that reason.
- **The connection leaving the transaction**, at the same two places, after `quiesce()` —
  once the worker's reply has been processed — when `begun` and not `done`, and the worker
  reports no transaction.
- **`bulkWrite`/`output`**: their signal exists only inside `src/bulk.ts`, so the transaction
  cannot see it. The `bulkFor` target gains an optional `onAbandoned(cause)` that `bulk.ts`
  calls when its own signal fires; the client path passes none.

**The teardown asks, rather than assumes.** `if (begun && !done)` becomes: send `ROLLBACK` if
the worker reports a transaction open, skip it otherwise. A worker that has reported nothing yet counts as open, which is today's
behaviour: the default can only cost a `ROLLBACK` that fails, never skip one that was owed.
`commit()`'s `throwIfAborted()` is
replaced by the statement-entry check, so an explicit `commit()` after the death rejects with
`TRANSACTION_ABORTED` and the auto-commit path, which runs only on a live transaction, is
unaffected.

## 5. Decisions

- **D1 — Option 1, not the savepoint** (§2).
- **D2 — `TRANSACTION_ABORTED` is a new public code**, minted by the library because the
  library decides the death; the cause travels as `cause`. The transaction's own rejection
  (R2) keeps the error that explains *why*, and uses `TRANSACTION_ABORTED` only where there
  is none to keep: a connection that left its transaction after a statement that succeeded.
- **D3 — Inside, one code for every cause** (R3). The alternative left a callback that caught
  an error testing four codes, one of them the consumer's own reason, which can be anything.
- **D4 — A pre-aborted write kills too** (R1), for a one-sentence rule.
- **D5 — The discriminator is the SQL, not the method** (R1).
- **D6 — The connection's own report is the second trigger** (R1), because the same autocommit
  escape follows a caught `SQLITE_FULL` and no abort is involved.
- **D7 — `rollback()` never reaches the worker once the transaction is dead** (R4).
- **D8 — Breaking, and said so** in `CHANGELOG.md` (user, 2026-09-10).

## 6. What this promises, and what it does not

**It promises** that a transaction is atomic whatever the callback catches: no statement of a
transaction ever runs outside it, a rejected write never has an effect, and an interrupted
write no longer costs a worker.

**It does not interrupt the callback.** JavaScript cannot stop a running function from
outside: synchronous code and awaits on anything but the database run on. The callback is
detached — every statement it issues rejects — and ends at its next uncaught rejection.
Exposing a `tx.signal` for the consumer to hand to a `fetch` would reach those awaits; it is
not part of this design.

**It does not make a memory VFS survive an eviction.** It removes the eviction this defect
caused; an eviction for any other reason — a crashed worker — still loses a memory database,
as it always has.

## 7. Out of scope

- `tx.signal` (§6).
- Any change to the client path: outside a transaction each statement is its own commit, and
  none of this applies.
- The dropped-generator limit of `mem:state`, which is unrelated and unchanged.

## 8. Tests and measurements

**M1, before any code — the read premise (R7).** On the `async` build, both engines, n≥3: a
long read inside a transaction cut mid-step by its own signal, caught; then an `INSERT` and
commit. Expected: the transaction survives and commits. Also record what `PRAGMA
max_page_count` does to a caught `INSERT` that hits `SQLITE_FULL` — whether SQLite leaves the
transaction there is the case D6 exists for, and the answer decides whether a browser test of
it is possible or a unit test must stand alone.

**Browser tests** (both engines; the build named per test; each with the mutation that turns
it red):

1. `async`, a write cut mid-step by its own signal, caught: the next `tx.read()` rejects with
   `TRANSACTION_ABORTED` whose `cause` is the reason; the transaction rejects with the reason;
   none of the transaction's rows is in the database; the worker was not replaced
   (`creationTime` unchanged, `debug: true`).
2. The same, uncaught, on `MemoryVFS` `async`: rejects with the reason, the table created
   before the transaction still exists, no eviction.
3. `sync` without isolation, `MemoryVFS`, a write abandoned and caught: the transaction
   rejects and the write's rows are absent — they used to be committed.
4. A write whose signal is already aborted at the call: the transaction dies.
5. A write abandoned by its own `timeout`: as 1, with `OPERATION_TIMEOUT`.
6. `async`, a read cut mid-step and caught: the transaction continues and commits (M1 made
   permanent).
7. A write issued through `tx.first()` (`INSERT … RETURNING`), abandoned: the transaction dies.
8. `tx.bulkWrite()` abandoned inside a transaction: the transaction dies; `tx.output()`
   abandoned: dies, and no staging table remains.

**Unit tests** (`tests/unit/transaction.test.ts`, fake worker):

- After the transaction's own signal: an explicit `commit()` rejects with
  `TRANSACTION_ABORTED`, `cause` the reason — *refuses an explicit commit() once the signal has
  fired* flips from `toBe(reason)`, and still asserts no `COMMIT` reached the worker.
- `rollback()` on a dead transaction resolves and sends nothing.
- The worker reporting no transaction after a failed statement kills the transaction, and the
  teardown sends no `ROLLBACK` and evicts nothing.
- The worker reporting a transaction open after an abandoned write: the teardown sends
  `ROLLBACK` (R5).

**Existing tests that change**, and why: the unit test above; `tests/browser/close.test.ts`,
*rejects — never hangs — a statement the callback issues after close()*, whose statement now
reports `TRANSACTION_ABORTED` where it reported `CLIENT_CLOSED` — the transaction itself still
rejects with `CLIENT_CLOSED`. And the fake worker of `tests/unit/transaction.test.ts` must
report `inTransaction` like the real one — every test there that asserts the `executed` list
depends on the teardown's new question, so the fake has to answer it truthfully (open after
`BEGIN`, closed after `COMMIT`/`ROLLBACK`). Nothing else should move; anything else that does
is a finding.

## 9. Documentation

- **`API.md`, *Inside a transaction*:** replace the sentence step 1 added — it says a caught
  statement error "changes nothing", which is false for a write — with R1-R4 in consumer
  terms: a write that is abandoned abandons the transaction; a read does not; what the
  transaction and later statements reject with; `rollback()` on an abandoned transaction.
- **`API.md`, *Error handling*:** a `TRANSACTION_ABORTED` row.
- **`CHANGELOG.md`, `## Unreleased`:** *Breaking* (statements after an abandoned transaction
  report `TRANSACTION_ABORTED`), *Added* (the code), *Fixed* (the four defects of §1, in
  consumer terms).
- **Step 1's leftover:** the header of `tests/browser/tx-timeout.test.ts` points at
  "AGENTS.md / the task brief" for why writes are excluded — neither says so — and says
  SQLite installs no progress handler, where it is `worker.ts` that installs none. Rewrite it
  to state the reason, and add the write case to that file or to this design's tests.
