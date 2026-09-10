# A transaction ends once, and its handle knows it — design

**Status:** approved in chat 2026-09-10, not yet planned.
**Branch:** `fix/tx-statement-timeout`, as its second step. The first step — a per-statement
`timeout` inside `transaction()`, which used to be silently ignored — is already committed on
the branch; this design is what restoring it exposed, and what checking one of its own claims
exposed next (§1.2).

**One breaking change**, for a released behaviour: `signal` on `transaction()` shipped in
`1.0.0-rc.4`, and a statement the callback issues after that signal fired rejects there with
`signal.reason`. It will reject with `TRANSACTION_CLOSED` (§3, R3). The other behaviour
changes of this design either fix a released defect (§1.2 is in rc.4) or touch options that have
never been released (`timeout`, the transaction's abandonment by `close()`).

## 1. The problem, measured

Two defects, found one after the other, both measured on 2026-09-10 in this container, three
runs per case on Chromium and Firefox, every case identical across runs and engines.
Throwaway probes and raw outputs: `.scratchpad/probe-autocommit/` (not versioned).

### 1.1 An interrupted write leaves the transaction without anyone knowing

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

Inside a transaction: `INSERT (1)`, then an `INSERT … SELECT` of 1 000 000 rows cut by its own
`signal` after 30 ms, then `INSERT (2)`.

| Build | Callback | What happened | Worker evicted |
|---|---|---|---|
| `async` (`OPFSAdaptiveVFS`, `OPFSWriteAheadVFS`, `MemoryVFS`), and `sync` under cross-origin isolation (`MemoryVFS`) | catches | `INSERT (1)` is gone inside the callback: SQLite rolled back. `INSERT (2)` runs in autocommit and **lands durably**. `COMMIT` fails with *cannot commit - no transaction is active*, the transaction rejects — with row 2 in the database. | yes, every run |
| same | does not catch | Rows correct, but the fallback `ROLLBACK` fails for the same reason and `onPoisoned` evicts the worker. | yes, every run |
| `sync` without isolation (`OPFSWriteAheadVFS`, `MemoryVFS`) | catches | Nothing can cut the running `step()`: the write completes, its 1 000 000 rows stay in the transaction and are **committed**, although the caller received a rejection. | no |
| same | does not catch | Clean rollback. | no |

**On a memory VFS an eviction destroys the database.** After the uncaught case on
`MemoryVFS` the next read fails with `no such table: t` — a table created and committed before
the transaction. The respawned worker opens a fresh, empty memory database.

### 1.2 A transaction handle outlives its transaction

**`tx` keeps a direct reference to its worker after the transaction is over.** The lease goes
back to the pool, the worker serves someone else, and every method of `tx` still talks to it —
bypassing the scheduler entirely. Only `commit()` and the statements carry a guard, and only
against the transaction's own signal: after an abandonment `rollback()` has none, and after a
NORMAL end nothing has one at all. Present in `1.0.0-rc.4`, where `rollback()` is the same
unguarded `exec(worker, 'ROLLBACK')`.

`poolSize: 1`, so the next transaction lands on the same worker. Transaction A ends; B starts,
writes `b1`, pauses between two statements; A's `tx` is used; B writes `b2` and commits.

| How A ended | Late call on A's `tx` | What happened to B | Worker evicted |
|---|---|---|---|
| abandoned by its signal | `rollback()` — resolves | **destroyed**: `b1` rolled back, `b2` in autocommit and durable, B's `COMMIT` fails | yes |
| committed normally | `rollback()` — resolves | **destroyed**, the same way | yes |
| committed normally | `write('late')` — resolves | **contaminated**: `late` joins B and commits with it | no |
| control: no late call | — | commits `b1`, `b2` | no |

**Read from the code, not measured:** where the worker is idle rather than inside another
transaction, a late write runs on its own in autocommit — **outside the origin's write lock and
without bumping the barrier's epoch**, since it never passes through `acquireInstrumented`. And
the same escape is reachable INSIDE a callback: with `autoCommit: false`, a statement issued
after an explicit `tx.commit()` or `tx.rollback()` runs on the leased worker in autocommit.

## 2. The decisions (user, 2026-09-10)

**A write that is abandoned abandons its transaction, on every build.** It is the only rule
that is uniform: where a step can be cut SQLite has already decided it, and where it cannot,
the library decides the same thing on purpose. A rejection then always means *no effect*.

**A transaction handle is closed once its transaction has ended, however it ended** — commit,
rollback, or death. Nothing a closed handle does reaches the worker.

**The callback can stop its own work: `tx.signal`.** The library stops an abandoned callback
only at its next database call; a `fetch`, a timer or a loop of its own runs on for a
transaction that is gone. `tx.signal` is what the callback hands to that work — the pattern of
TanStack Query's `queryFn`, which receives a `signal` from the library that owns the lifetime
(user, 2026-09-10).

**The alternative to the first was designed and refused:** never cut a write inside a
transaction, let it finish, and undo it with a savepoint, so the transaction survives. It keeps
what preceded the write, and pays for it with the purpose of `timeout`: an abandoned write would
wait for its own end, with the write lock held, and then be thrown away — costlier than no
timeout at all. A consumer would rationally never set one. It would also add a
`SAVEPOINT`/`RELEASE` round trip to every write in every transaction. **Do not re-propose it
without an answer to that.**

## 3. The rules

**R1 — How a transaction ends.** Normally, by a `COMMIT` or a `ROLLBACK` that succeeds —
explicit, or the one the transaction issues itself when the callback returns or throws. Or by
**death**. Three causes of death exist and are unchanged: its own `signal`, its own `timeout`,
`close()`. Three are new:

- **A write statement is abandoned**: any statement issued through the transaction whose SQL
  `isWriteQuery()` classifies as a write, rejected by its OWN `signal` or `timeout` — whichever
  method issued it (`tx.read()`, `tx.first()`, `tx.chunk()` and `tx.stream()` do not refuse a
  write, so the method cannot be the discriminator). **This includes a signal already aborted
  at the call**, where the statement never reached the worker: the rule stays one sentence
  instead of depending on when the abort landed. `isWriteQuery()` errs toward the writer,
  which here errs toward dying — the safe direction.
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
| the connection left the transaction | the error of the statement after which it did; if that statement succeeded, a `TRANSACTION_CLOSED` naming it |

A caller testing `e.code === 'OPERATION_TIMEOUT'` around `db.transaction()` catches a timeout
whether it was the transaction's or a statement's.

**R3 — A statement on a closed handle rejects with `TRANSACTION_CLOSED`**, before any round
trip, however the transaction ended: `read`, `write`, `first`, the first `next()` of
`chunk`/`stream`, and `bulkWrite`/`output` at the call — where `readOnly`'s refusal already
sits, for the same reason. **`cause` carries the cause of death when there was one, and is
absent after a normal end**, which is how a consumer tells a transaction that was abandoned
from a handle used too late. Around a death, two statements keep their own value:

- **the statement that caused it** rejects with its own value, unchanged — the ownership rule
  of `docs/superpowers/specs/2026-09-07-uniform-timeout-design.md` holds;
- **a statement in flight when the transaction dies** of another cause rejects with the cause,
  as today (pinned by *aborts a statement that carries a signal of its own* in
  `tests/unit/transaction.test.ts`).

One test inside the callback, `e.code === 'TRANSACTION_CLOSED'`, means *this transaction is
over, stop*. This is not one error per remaining line: an uncaught rejection ends the callback
at the first `await`, and `TRANSACTION_CLOSED` is reached only by a callback that caught the
first error and went on, one waiting on something other than the database when an outside
abort landed, or code holding the handle after the end. It is the only way to stop a callback
JavaScript cannot interrupt.

**R4 — `commit()` and `rollback()` on a closed handle never reach the worker**, and settle by
whether the state they ask for is the state the transaction is in:

| How the transaction ended | `commit()` | `rollback()` |
|---|---|---|
| committed | resolves | resolves, **and warns** — the data it asks to undo is committed |
| rolled back | rejects, `TRANSACTION_CLOSED` | resolves |
| died | rejects, `TRANSACTION_CLOSED`, `cause` the cause | resolves |

`rollback()` never throws on a closed handle, so a `finally { await tx.rollback() }` written
for safety cannot turn a success into a failure — PostgreSQL behaves the same way (a `ROLLBACK`
outside a transaction warns and does nothing), and so does Python's `sqlite3`. The one case
that would hide a real mistake is code that believes it undid something after committing,
and that is the case that warns. **The warning is unconditional**, through `logger.always.warn`
— the precedent `src/logger.ts` already set for pool shrinkage — because a warning visible only
under `debug: true` is the same as silence. `commit()` after a death rejects because the data
it asks for is not in the database.

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

**R8 — `tx.signal` aborts when the transaction dies, and only then.** A read-only
`AbortSignal` on `SQLiteTransactionDB`, beside `commit()` and `rollback()` — not on
`SQLiteQueryAPI`, which the client shares. **Its reason is the cause of death**, the very value
`db.transaction()` rejects with (R2), so a `fetch` cut by it rejects with `OPERATION_TIMEOUT`
or the consumer's own reason, not with a third value. **A normal end does not abort it**: with
`autoCommit: false`, a callback that committed explicitly may legitimately go on working — call
a service, say — and cutting that would be a regression; once the callback has returned there
is nothing left to cut. Passing it to a statement of the same transaction is redundant and
harmless, since every statement already carries it.

```ts
await db.transaction(async (tx) => {
  const rows = await tx.read('SELECT …');
  const priced = await fetch(url, { signal: tx.signal }); // cut if the transaction dies
  await tx.write('INSERT …', [priced]);
});
```

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

**The transaction owns one piece of state, how it ended**, set exactly once: `committed`,
`rolled-back`, or `died` with its cause. Every public method of `tx` reads it at its entry,
before anything else, and applies R3/R4. It is set by `commit()`/`rollback()` once their
statement succeeds (where `done = true` is set today), by a death, and — as a last resort — in
the transaction's `finally`, so no path out of `transaction()` can leave a handle open.

**A death aborts an internal `AbortController` merged into the transaction's signal**, with the
cause as its reason. That is how the new causes join the existing machinery: the race against
the callback rejects the transaction with the cause (R2), and a statement in flight rejects
with it (R3). The three existing causes set `died` from the same signal's `abort` event.

**`tx.signal` is that merged signal, exposed as it is.** It already aborts on every cause of
death with the cause as reason, and on nothing else: the transaction's `finally` releases the
merge's listeners without aborting it, so a normal end leaves it un-aborted for good, and a
`close()` after the end cannot reach it. The internal controller itself is never exposed — the
consumer can listen, not abort.

**Where the new causes of death are detected:**

- **An abandoned write**, in `withSignal`'s `settled` and in `releasing`'s `finally` — the two
  places a statement ends (`mem:architecture`). Both already know the statement's own signal
  (the `withDeadline` result); they need its SQL, which becomes a parameter. Rejected with the
  own signal's reason, SQL a write: the transaction dies with that reason.
- **The connection leaving the transaction**, at the same two places, after `quiesce()` —
  once the worker's reply has been processed — when `begun` and the handle is not closed, and
  the worker reports no transaction.
- **`bulkWrite`/`output`**: their signal exists only inside `src/bulk.ts`, so the transaction
  cannot see it. The `bulkFor` target gains an optional `onAbandoned(cause)` that `bulk.ts`
  calls when its own signal fires; the client path passes none.

**The teardown asks, rather than assumes.** `if (begun && !done)` becomes: send `ROLLBACK` if
the worker reports a transaction open, skip it otherwise. A worker that has reported nothing
yet counts as open, which is today's behaviour: the default can only cost a `ROLLBACK` that
fails, never skip one that was owed. The auto-commit path runs only on a handle that is still
open, so it is unaffected; `commit()`'s `throwIfAborted()` is subsumed by the entry check.

## 5. Decisions

- **D1 — Option 1, not the savepoint** (§2).
- **D2 — `TRANSACTION_CLOSED` is a new public code**, one for every way a handle can be over.
  It was first named `TRANSACTION_ABORTED`, which a handle used after a successful commit made
  false. The transaction's own rejection (R2) keeps the error that explains *why*, and uses
  `TRANSACTION_CLOSED` only where there is none to keep: a connection that left its
  transaction after a statement that succeeded.
- **D3 — Inside, one code for every cause** (R3). The alternative left a callback that caught
  an error testing four codes, one of them the consumer's own reason, which can be anything.
- **D4 — A pre-aborted write kills too** (R1), for a one-sentence rule.
- **D5 — The discriminator is the SQL, not the method** (R1).
- **D6 — The connection's own report is a cause of death** (R1), because the same autocommit
  escape follows a caught `SQLITE_FULL` and no abort is involved.
- **D7 — A closed handle never reaches the worker** (R3, R4, §1.2).
- **D8 — `rollback()` on a closed handle resolves; after a commit it also warns,
  unconditionally** (R4, user, 2026-09-10).
- **D9 — Breaking, and said so** in `CHANGELOG.md` (user, 2026-09-10).
- **D10 — `tx.signal`, not a second callback parameter** (user, 2026-09-10). A context object
  as the callback's second argument — `(tx, { signal })` — keeps `tx` a pure surface of
  methods, and was weighed. It loses on the consumer's side: `tx` is what gets handed to the
  consumer's own helpers (`saveOrder(tx, order)`), and with a second parameter each of them
  must also take and forward the signal, an omission that is silent — the database stays
  correct, only the helper's own `fetch` runs on. The signal describes the transaction's
  lifetime, and `tx` is the object that carries it (R3, R4). TanStack's `queryFn` context is
  the analogue of `tx`, not of a second parameter.
- **D11 — `tx.signal` aborts on death only, with the cause as reason** (R8).

## 6. What this promises, and what it does not

**It promises** that a transaction is atomic whatever the callback catches and wherever its
handle ends up: no statement of a transaction ever runs outside it or inside another one, a
rejected write never has an effect, and an interrupted write no longer costs a worker.

**It does not interrupt the callback.** JavaScript cannot stop a running function from
outside: synchronous code and awaits on anything but the database run on. The callback is
detached — every statement it issues rejects — and ends at its next uncaught rejection.
`tx.signal` reaches the awaits the consumer hands it to, and only those: work that ignores it
runs on.

**It does not make a memory VFS survive an eviction.** It removes the evictions these defects
caused; an eviction for any other reason — a crashed worker — still loses a memory database,
as it always has.

## 7. Out of scope

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

**M1 done, 2026-09-10, three runs per case on both engines, all identical.** The read premise
holds: a read cut after ~35 ms (the full query takes seconds) on `OPFSAdaptiveVFS` and
`MemoryVFS`, `async`, left the transaction open — it committed both rows and no worker was
replaced. `SQLITE_FULL` from `max_page_count` (`OPFSAdaptiveVFS` `async`, `MemoryVFS` `sync`)
undid the statement alone and the transaction committed, so D6 cannot be provoked that way in a
browser and **its test is a unit test only**. Noted in passing, out of scope: that
`SQLITE_FULL` reached the client with neither `code` nor `sqliteCode` set. Probe:
`.scratchpad/probe-autocommit/m1.test.ts`.

**Browser tests** (both engines; the build named per test; each with the mutation that turns
it red):

1. `async`, a write cut mid-step by its own signal, caught: the next `tx.read()` rejects with
   `TRANSACTION_CLOSED` whose `cause` is the reason; the transaction rejects with the reason;
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
9. §1.2 made permanent, `poolSize: 1`, the next transaction paused between two statements:
   an abandoned transaction's `tx.rollback()` resolves and the next transaction commits both
   its rows; a committed transaction's `tx.rollback()` the same; a committed transaction's
   `tx.write()` rejects with `TRANSACTION_CLOSED` without `cause`, and its row is nowhere.
10. `autoCommit: false`: a statement after an explicit `tx.commit()` rejects with
    `TRANSACTION_CLOSED`; so does one after an explicit `tx.rollback()`.
11. `tx.signal`: aborted, with the write's reason, when an abandoned write kills the
    transaction; aborted with `OPERATION_TIMEOUT` when the transaction's own `timeout` expires
    while the callback awaits something that is not a statement; NOT aborted after a normal
    end, including after an explicit `tx.commit()` under `autoCommit: false` and after a later
    `close()`.

**Unit tests** (`tests/unit/transaction.test.ts`, fake worker):

- After the transaction's own signal: an explicit `commit()` rejects with
  `TRANSACTION_CLOSED`, `cause` the reason — *refuses an explicit commit() once the signal has
  fired* flips from `toBe(reason)`, and still asserts no `COMMIT` reached the worker.
- The R4 table, cell by cell: the executed list never gains a statement after the end, and
  `rollback()` after a commit writes exactly one warning through an injected logger sink —
  none in the other cells.
- The worker reporting no transaction after a failed statement kills the transaction, and the
  teardown sends no `ROLLBACK` and evicts nothing.
- The worker reporting a transaction open after an abandoned write: the teardown sends
  `ROLLBACK` (R5).

**Existing tests that change**, and why: the unit test above; `tests/browser/close.test.ts`,
*rejects — never hangs — a statement the callback issues after close()*, whose statement now
reports `TRANSACTION_CLOSED` where it reported `CLIENT_CLOSED` — the transaction itself still
rejects with `CLIENT_CLOSED`. And the fake worker of `tests/unit/transaction.test.ts` must
report `inTransaction` like the real one — every test there that asserts the `executed` list
depends on the teardown's new question, so the fake has to answer it truthfully (open after
`BEGIN`, closed after `COMMIT`/`ROLLBACK`). Nothing else should move; anything else that does
is a finding.

## 9. Documentation

- **`API.md`, *Inside a transaction*:** replace the sentence step 1 added — it says a caught
  statement error "changes nothing", which is false for a write — with R1-R4 in consumer
  terms: a write that is abandoned abandons the transaction; a read does not; what the
  transaction and later statements reject with; a handle is closed once its transaction has
  ended; what `commit()` and `rollback()` do then; `tx.signal`, with the example of R8.
- **`API.md`, *client*.transaction:** `tx.signal` beside `commit()` and `rollback()` wherever
  the transaction object's members are listed.
- **`API.md`, *Error handling*:** a `TRANSACTION_CLOSED` row.
- **`CHANGELOG.md`, `## Unreleased`:** *Breaking* (statements after an abandoned transaction
  report `TRANSACTION_CLOSED`), *Added* (the code, and `tx.signal`), *Fixed* (§1.1's four defects and §1.2's
  handle, in consumer terms — §1.2 is a released defect).
- **Step 1's leftover:** the header of `tests/browser/tx-timeout.test.ts` points at
  "AGENTS.md / the task brief" for why writes are excluded — neither says so — and says
  SQLite installs no progress handler, where it is `worker.ts` that installs none. Rewrite it
  to state the reason, and add the write case to that file or to this design's tests.
