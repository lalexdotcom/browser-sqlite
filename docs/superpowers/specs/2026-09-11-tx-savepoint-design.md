# A caught write abort leaves the transaction whole — design

**Status:** approved in chat 2026-09-11, section by section; not yet planned.
**Branch:** `fix/tx-savepoint`, from `main` after `9479f4a`.
**Amends** `docs/superpowers/specs/2026-09-10-transaction-abort-design.md`: its R1 (first two
bullets), R5 and D1 are superseded by this design; everything else in it stands. That spec
gets a dated amendment pointing here.

**Not breaking for any released version.** The rule this replaces — "a write abandoned while
it runs abandons its transaction" — was introduced by merge `eeabe06` and has never been
released. In `1.0.0-rc.4` the same case produced the autocommit defect of that spec's §1.1.

## 1. The problem

The user's three use cases for errors inside `transaction()` (2026-09-10):

1. The transaction's own `signal`/`timeout` fires: everything stops, `tx.signal` fires.
2. An error escapes the callback — any `throw`, a statement's own `signal`/`timeout`, an error
   from a `tx` method: everything stops, `tx.signal` fires.
3. A `tx` method's error that the callback CATCHES — its own `signal`/`timeout` included: the
   callback goes on, still inside the transaction. *"Je catch une erreur et je continue"* is
   normal behaviour (user, 2026-09-11).

What `main` does today, read from the code on 2026-09-11:

| A `tx` statement fails… | Today | Case 3 met? |
|---|---|---|
| by its own SQL error (constraint…), SQLite undoing the statement alone | rejects with the error; the transaction goes on; `COMMIT` keeps what preceded | yes — **but no test pins it** |
| by an SQL error after which the connection left the transaction (`ON CONFLICT ROLLBACK`, `IOERR`…) | the transaction dies (D6); later calls reject `TRANSACTION_CLOSED`, `cause` the error; `tx.signal.aborted` is already true when the caller's `catch` runs | nothing left to save |
| by its own signal, already aborted at the call | nothing reaches the worker; rejects alone | yes |
| a READ, by its own signal/timeout while it runs | cut; SQLite undoes nothing for a read; the transaction goes on | yes |
| a WRITE, by its own signal/timeout while it runs — `bulkWrite`/`output` included | `isAbandonedWrite` → `die(e)`: the transaction dies even when caught | **no** |

The last row is the whole of this design.

**Why the write cannot simply be cut and undone.** SQLite's `sqlite3VdbeHalt`
(`src/vdbeaux.c`, read on 2026-09-11 from the SQLite repository's `master`): for
`SQLITE_INTERRUPT` on a statement that is not read-only, it calls `sqlite3RollbackAll`, then
`sqlite3CloseSavepoints`, then sets `autoCommit = 1`. A savepoint does not survive a cut. So a
write the callback may continue past must NOT be cut; it must run to its end and be undone.
Only `SQLITE_NOMEM`/`SQLITE_FULL` with a statement journal roll back the statement alone,
which is what TX-M1 observed for `SQLITE_FULL`.

## 2. Decisions (user, 2026-09-11)

- **D1 — SQLite's statement-level model, not PostgreSQL's.** A statement that rejects has no
  effect; the statements before it stand; the transaction goes on if the error is caught. It
  is what a caught constraint violation already does here, and what JavaScript does: in
  `await a(); await b(); await c();`, `c` throwing leaves `a` and `b` done. A `try` bounds a
  recovery zone, not an atomic unit. PostgreSQL's model — any error poisons the transaction
  until `ROLLBACK` — contradicts case 3; its own tooling (psql's `ON_ERROR_ROLLBACK`, pgjdbc's
  `autosave`) goes back to per-statement savepoints (from memory, not verified in the session).
  A consumer who wants "these three or none" lets the error escape (case 2), or waits for the
  rc.6 `tx.savepoint()` (§6).
- **D2 — A write's own abort does not cut it; the transaction's death does.** The caller's
  promise rejects at once; the write runs to its end on the worker and a savepoint undoes it.
  If the rejection then escapes the callback, the transaction dies (case 2) and the running
  write is cut, exactly as today. The library cannot know at abort time whether the caller
  will catch; it does not need to.
- **D3 — The wait is bounded by nothing new** (user, 2026-09-11, over the two alternatives
  below). The next statement,
  or the `COMMIT`, waits for the abandoned write to end and be undone, with the origin's write
  lock held. What bounds it: the transaction's own `signal`/`timeout`, and the waiting
  statement's own `signal`/`timeout` — which rejects that statement alone, since it has not
  reached the database. `drainTimeout` as a bound was refused (it would kill a long legitimate
  write), and so was failing the next statement fast with a new error code (a public code and
  a busy-wait left to the consumer). Consistent with the refusal to police the write-lock
  holder (`mem:state`, the origin write lock).
- **D4 — Approach B: the worker executes the savepoint inside the write's own message.**
  Approach A — the transaction sending `SAVEPOINT`/`RELEASE` itself, one round trip each — was
  recommended for stability (no protocol change). The user chose B after the measurement,
  holding that stability is what tests guarantee (§8). Measured (`mem:measurements`,
  TX-SAVEPOINT, K=200, three runs per engine): A adds 0.12-0.13 ms per opted-in write on
  Chromium and 0.24-0.26 ms on Firefox; a proxy of B that over-states B's cost adds
  0.010-0.020 ms and 0.095-0.115 ms. B saves 56-92% of A's cost, 0.11-0.15 ms per write.
- **D5 — The savepoint is concluded by the NEXT message, never by the write's own.** On the
  `sync` build without cross-origin isolation the worker reads nothing during `step()`, so it
  would `RELEASE` before learning that the write was abandoned, and the undo would be
  impossible. So the write's message runs `SAVEPOINT` + the statement and leaves the savepoint
  open; the next message the transaction sends begins by concluding it — `RELEASE`, or
  `ROLLBACK TO` + `RELEASE` when the write was abandoned. Zero extra round trips on both paths.
- **D6 — One savepoint per `bulkWrite`/`output` batch, not one per load.** A load-wide
  savepoint would contain whatever the callback runs between two batches (`enqueue`, then
  `tx.write`, then `enqueue`), and undoing the load would silently undo a write that had
  resolved. Per batch, an abandoned load keeps its completed batches — what an abandoned
  `bulkWrite` already does outside a transaction, and what a batch that FAILS already does
  inside one. Every batch already carries the load's signal, so it becomes a savepointed write
  with no code of its own. Proposed once as one savepoint per load, corrected before the spec.
  The user's framing: all or nothing is what the transaction is for; a callback that catches
  an error and goes on to commit keeps what was written, `bulkWrite` included — the
  "multi-write" behaviour.
- **D7 — One library savepoint at a time, under a fixed name, `__bsq_sp`.** The entry wait
  (D3) and the conclusion (D5) guarantee that ours is always the top of SQLite's savepoint
  stack and is concluded before anything else runs, so a consumer's own savepoints are never
  above it. A constant name keeps the three statements in the worker's statement cache.
- **D8 — Transaction-control statements are never wrapped.** `SAVEPOINT`, `RELEASE`,
  `ROLLBACK`, `BEGIN`, `COMMIT`, `END`: they are not data writes to undo, and
  `tx.write('RELEASE u', { timeout })` inside our savepoint would pop ours with it.
- **D9 — The conclusion is structural, not a discipline.** The transaction hands the query
  helpers a facade over its worker whose `query()` attaches the pending conclusion; no path to
  the worker bypasses it.

**This is the answer the 2026-09-10 spec's §2 asked for** before its refused alternative could
be re-proposed. That alternative never cut a write, so an abandoned write waited for its own
end and then was thrown away, and a `timeout` bought nothing. Here the caller gets its
rejection at the deadline; the write is cut whenever the caller does not catch; and the wait
lands only on a caller who chose to continue.

## 3. The rules

**R1 — A write abandoned by its own `signal`/`timeout` while it runs** — any statement whose
SQL `isWriteQuery()` classifies as a write (D5 of the 2026-09-10 spec, kept), except the
transaction-control statements of D8 — **rejects at once with its own reason** (`signal.reason`
verbatim, or `OPERATION_TIMEOUT`) **and has no effect.** Caught, the transaction goes on: the
statements before it stand and a later `COMMIT` commits them. Uncaught, it is case 2.

**R2 — The next statement waits.** Any statement, `commit()`, or the automatic `COMMIT` issued
after R1 first waits until the abandoned write has ended and been undone. Its own
`signal`/`timeout` cuts that wait and rejects it alone — it never reached the database — and
the transaction goes on. The transaction's own `signal`/`timeout` or `close()` cuts it and
kills the transaction, cutting the write as well.

**R3 — Uniform across builds.** On the `sync` build without isolation the write could never be
cut; it now reaches the same outcome as everywhere else — undone, transaction alive — where
until now the library killed the transaction there to match the other builds (old R5).

**R4 — `bulkWrite()`/`output()`.** A load abandoned while a batch runs undoes that batch alone
(D6). Caught, the completed batches stand and the transaction goes on; uncaught, case 2 undoes
everything. `output()` has no effect on its target either way: the target is replaced only at
`close()`, and an abandoned load drops its staging table. A load created with a signal already
aborted is unchanged: it writes nothing and rejects alone.

**Unchanged:** cases 1 and 2; an abandoned read (old R7); a write whose own signal was already
aborted at the call (old D4, reversed); the connection leaving the transaction by itself (old
R1 third bullet, D6) — which also covers an abandoned write that ends in `IOERR` or similar
while it runs on: the transaction dies with that write's error. `tx.signal` (old R8): it does
not fire for a caught abandoned write, since `transaction()` does not reject.

## 4. The mechanism

**Protocol (internal).** `SQLOptions` in `src/types.ts` gains
`savepoint?: { conclude?: 'release' | 'undo'; open?: true }`. In its `query` case, before the
statement, the worker:

1. concludes: `'release'` → `RELEASE __bsq_sp`; `'undo'` → `ROLLBACK TO __bsq_sp`, then
   `RELEASE __bsq_sp`;
2. opens: `SAVEPOINT __bsq_sp`;
3. runs the statement as today.

A failure in step 1 or 2 is the query's `error`, reported like any other, with
`inTransaction`. The client treats a failed conclusion as the transaction's death, cause that
error: it can no longer promise that a rejected write had no effect.

**Amended 2026-09-11 (final review):** the worker makes that death happen — on any failure
in step 1 or 2 it issues a full `ROLLBACK` before replying, so the reply reports
`inTransaction: false` and the transaction dies through D6 with that error as cause. Found by
the final review: `tx.write('…; RELEASE u', …)` abandoned pops `__bsq_sp` with `u`, and the
next conclusion fails.

**The facade (D9).** `createTransaction` stops handing its `PoolWorker` to `readWorker`,
`writeWorker`, `firstWorker`, `chunkWorker`, `streamRows` and `exec`. It hands them a facade
whose `query()` attaches `{ conclude }` from the transaction's single pending-conclusion slot,
clears the slot, and delegates; every other member delegates unchanged. `BEGIN` and `COMMIT`
go through it. **The teardown `ROLLBACK` does not**: it discards the pending conclusion first
— a full rollback discards every savepoint, and a `RELEASE` sent to a connection that has
already left its transaction would fail and get a healthy worker evicted through `onPoisoned`
(old R6).

**Which writes open a savepoint.** At the call, in `withSignal`: SQL is a write (D8
excluded) AND the caller gave a `signal` or `timeout` AND it was not already aborted
(`abortedAtCall`). Only those pay (D4).

**Two signals, separated.** Today `withSignal` merges the transaction's signal and the
statement's own into one, and `writeWorker`/`drain` interrupt on either. For a savepointed
write the query runs with the TRANSACTION's signal only — so only a death cuts it — and the
caller's promise races the statement's own signal. On that signal:

- the caller's promise rejects with the own reason at once — `settled` no longer awaits
  `worker.quiesce()` before rejecting in this case, since that would deliver the rejection at
  the write's end and defeat the `timeout`;
- the query keeps running in the background, consuming and discarding any `RETURNING` rows so
  the worker's credits keep flowing, and its end resolves the transaction's `abandoned`
  promise;
- the pending conclusion becomes `'undo'`.

A generator method (`chunk`/`stream`) issuing a write follows the same split in `releasing`.

**The entry wait (R2).** Every public method of `tx` and the automatic `COMMIT`, after the
closed-handle check and before anything else, awaits `abandoned` raced against its own signal
and the transaction's. The `owesWait` rule is untouched: a statement refused by `pool.ts`'s
reuse guard owes nothing.

**When the abandoned write ends.** After `quiesce()`: if the worker reports no transaction,
the transaction dies with that write's error, or a `TRANSACTION_CLOSED` naming it (old D6), and
the pending conclusion is discarded. Otherwise the slot holds `'undo'` for the next message.

**`bulkWrite`/`output`.** Each batch is a `tx.write` carrying the load's signal, so it is a
savepointed write already. `bulkFor`'s `onAbandoned` hook — which kills the transaction when a
load is abandoned — is deleted: an abandonment between batches has nothing to undo, one during
a batch is R1. `output()`'s abort path drops its staging table through `tx.write`, which waits
and concludes first.

## 5. What this promises, and what it does not

**It promises** that a rejected statement inside a transaction never has an effect, whatever
the callback catches, on every build — and that catching it never costs the transaction.

**It does not** make a caught abort free: the next statement pays for the abandoned write's
remaining run, with the write lock held. It does not tell the caller how many rows an
abandoned `bulkWrite` kept — the rejection is `signal.reason`, as outside a transaction. It
does not change what an ordinary write without its own `signal`/`timeout` costs: nothing.

## 6. Out of scope

- **`tx.savepoint()`**, a nested all-or-nothing block returning a rollback callback — rc.6,
  `mem:follow-ups`. It will go through the same facade, so it concludes ours before opening its
  own.
- **The error code of a SQL error** — `SQLITE_FULL`, a constraint violation… reach the client
  as a plain `Error` (`mem:follow-ups`). A separate rc.5 subject.
- **`worker 1 lost; pool is now 1 of 2` on Firefox**, logged by every Firefox run of the
  TX-SAVEPOINT probe and never on Chromium (`mem:measurements`). Not investigated; separate.

## 7. Measurements

**Before any code** (throwaway probes in `.scratchpad/`, both engines, n≥3):

- **M1 — a write stopped after its first row.** Inside a transaction: `tx.first()` on a
  multi-row `INSERT … RETURNING`, and a `break` out of `tx.chunk()` on the same. Does stopping
  it roll the whole transaction back (a stop reaching the progress handler returns
  `SQLITE_INTERRUPT` on a statement that is not read-only)? If yes, that is a defect
  independent of this design and not released — stopping a running statement arrived with
  rc.5's interruption work — and either this spec is amended with how such a write is driven
  to its end before any code, or the defect is split off. The user decides which.
- **M2 — the premise.** `INSERT (1)`; `SAVEPOINT`; a multi-row write run to its end;
  `ROLLBACK TO`; `RELEASE`; `COMMIT`: row 1 present, the write's rows absent. On `async`,
  `sync` isolated and `sync` not isolated.

**M1 and M2 done, 2026-09-11, before any code** (`mem:measurements`, TX-M1M2; three runs on
each of five configurations — both engines on `async` and `sync` not isolated, plus `sync`
isolated — every result identical). **M1: no defect.** Stopping an `INSERT … RETURNING` after
its first row, through `tx.first()` or a `break` out of `tx.chunk()`, left the transaction whole:
it committed, all 50 000 rows kept, no worker replaced — SQLite runs a `RETURNING` statement's
whole DML in its first `step()`. This design needs no amendment for it and nothing is split off.
**M2: the premise holds** — the write run to its end is gone after `ROLLBACK TO`, the row before
the savepoint stays, on every configuration.

**After the code — M3.** TX-SAVEPOINT re-run with the real B in place of the proxy.

## 8. Tests

Every test with the mutation that turns it red. Browser tests on both engines, on `async`
(`OPFSAdaptiveVFS`), `sync` isolated (the isolated project, `MemoryVFS`) and `sync` not
isolated (`MemoryVFS` or `OPFSWriteAheadVFS`).

**Existing tests that invert:** `tests/browser/tx-abort.test.ts`, *abandons the transaction
when the callback catches it (async)* and *keeps none of a write that ran to its end on the
sync build (R5)*; the 2026-09-10 spec's test 7 (a write through `tx.first()` cut in flight —
subject to M1) and test 8 (`tx.bulkWrite()`/`tx.output()` abandoned: the transaction dies).
Nothing else should move; anything else that does is a finding.

**New:**

- **T1** — a long write abandoned by its own `timeout`, caught; then an `INSERT`; commit. The
  write before it is present, the abandoned write's rows are absent, the one after is present;
  no worker replaced (`creationTime`, `debug: true`). Red: conclude `'release'` for an abandoned
  write; or drive it with the merged signal (on a build that can cut, the transaction dies).
- **T2** — the caught rejection arrives near the deadline, not at the write's end. Red:
  `settled` awaiting `quiesce()` before rejecting.
- **T3** — the same rejection uncaught: `transaction()` rejects with it, nothing is kept,
  `tx.signal` aborted, and `transaction()` settles promptly on a build that can cut. Red: not
  cutting the background write on death.
- **T4** — the transaction's own `timeout` expires while an abandoned write runs: rejects
  `OPERATION_TIMEOUT`, nothing kept. Red: as T3.
- **T5** — the next statement carries its own `timeout` and waits behind an abandoned write:
  it rejects alone and the transaction commits. Red: treating it as an abandoned write.
- **T6** — the callback returns right after catching: the automatic `COMMIT` waits, and only
  what preceded the abandoned write is committed. Red: `COMMIT` without the conclusion.
- **T7** — unit, `tests/unit/transaction.test.ts`, fake worker: after an abandoned savepointed
  write, the first message of EVERY entry point — each `tx` method and `commit()` — carries
  `conclude: 'undo'`; after a completed one, `'release'`; the teardown `ROLLBACK` carries none.
  Parameterised over the methods, so a seventh one that bypasses the facade fails it. Red: one
  method calling the raw worker.
- **T8** — a consumer's savepoints: `SAVEPOINT u`, a caught abandoned write, `ROLLBACK TO u`:
  correct state. `tx.write('RELEASE u', { timeout })` is not wrapped. Red: removing D8's
  exclusion.
- **T9** — `tx.bulkWrite()` abandoned mid-load, caught: completed batches present, the batch in
  flight absent, the transaction commits. `tx.output()` abandoned, caught: target untouched,
  staging table gone, the transaction commits. Red: one savepoint per load.
- **T10** — D6 in a browser for the first time: an `INSERT OR ROLLBACK` violating a constraint
  kills the transaction; the next statement rejects `TRANSACTION_CLOSED`, `cause` the error.
  Red: removing `dieIfConnectionLeft`.
- **T11** — a caught SQL error (a `UNIQUE` violation) lets the transaction go on and commit
  what preceded it. Pins the table's first row, which no test covers today.

**Unit, worker protocol:** the fake worker of `tests/unit/transaction.test.ts` must honour
`savepoint` like the real one — it records the conclusion and the open in its `executed` list —
or every assertion on that list stops describing the real worker.

## 9. Documentation

- **`API.md`, *Inside a transaction*:** replace "A write abandoned while it runs abandons its
  transaction; an abandoned read does not" with R1-R4 in consumer terms, the price (R2)
  included.
- **`API.md`, *client*.bulkWrite (line 237) and `CHANGELOG.md` *Changed* (lines 109-112):**
  "run `bulkWrite()` on a `tx` if you need all or nothing" is wrong as advice (user,
  2026-09-11): all or nothing is what a transaction is for, whatever runs inside it. Replace it
  with a bare pointer to [`transaction()`](API.md#clienttransaction) — no explanation of what a
  transaction is. What a caught error inside one does is the general rule of *Inside a
  transaction* (R1, R4), not something `bulkWrite`'s section repeats.
- **`CHANGELOG.md`, `## Unreleased`, *Fixed*:** correct — not supplement — "A write abandoned
  while it runs now abandons its transaction on every build" (from `eeabe06`, never released):
  a write abandoned while it runs has no effect, and a caught one leaves the transaction whole.
- **The 2026-09-10 spec:** a dated amendment at the top, pointing here for R1, R5 and D1.
