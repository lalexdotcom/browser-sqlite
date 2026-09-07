# One `timeout`, every interruptible method — design

**Status:** approved 2026-09-07, not yet planned.
**Backlog item:** "`signal` and `timeout` travel together — `OptionsWithSignal` becomes
`Interruptible`", in `mem:follow-ups`, owed before rc.5 (user, 2026-09-05).

This design does two things the backlog entry asked for one of. It adds `timeout` to the
three methods that lack it, and — because doing so forced the question — it **changes what
`timeout` means everywhere**, reversing D4 of
`docs/superpowers/specs/2026-09-04-query-interruption-design.md`.

**Nothing here is a breaking change for a consumer.** `timeout` and `QUERY_TIMEOUT` were
added by the query-interruption lot on 2026-09-05 and sit in `## Unreleased` of
`CHANGELOG.md`; the last published version is `1.0.0-rc.4`, from 2026-08-31. No release has
ever carried either name.

## 1. The problem the generalization exposed

`timeout` is today a budget of SQLite **execution** time: the worker accumulates the wall
clock measured around each `sqlite.step()` into `spent`, and a progress handler interrupts
the statement when `spent + (now - stepStart)` passes the budget
([`src/worker/worker.ts`](../../../src/worker/worker.ts)). Everything outside `step()` is
free — the wait for a lease, the cross-tab write lock, the barrier drain, the worker round
trip, and the caller's own pauses between two chunks of a `stream()`.

Two consequences, and the second is what reopened D4.

**It does not generalize.** None of `transaction()`, `bulkWrite()` and `output()` is one
statement. A transaction spans caller code between its statements; `bulkWrite`/`output` span
many batches with the producer's own time in between. An execution budget on those would
either need cross-call accumulation, or silently hand out one budget per batch — the very
thing §3 of the interruption design refused for a multi-statement query ("a ten-statement
script does not silently get ten budgets").

**It is not predictable, and that is the deciding argument (user, 2026-09-07).** A
consumer who writes `timeout: 5000` believes they have bounded their call. They have not:
under cross-tab contention the same call can take twenty seconds of wall clock and never
approach its budget, because the clock only runs while SQLite has the floor. The option
answers a question nobody asked — *how much engine did this query burn* — in the vocabulary
of a question everybody asks.

The property the execution budget bought is real and is given up knowingly: a query was
never killed for time another tab's write lock made it wait. See §6.

## 2. The decision

**`timeout` is a wall-clock budget in milliseconds, counted from the call**, on every
method that accepts a `signal`. One sentence, one meaning, seven methods.

It is sugar over an `AbortSignal` this library owns, whose abort reason is a typed
`SQLiteError`. That ownership is the whole design, and §4 is short because of it.

## 3. The surface

**`OptionsWithSignal` becomes `Interruptible`**, and carries both members. The pairing is
structural, so a future option type cannot take one without the other:

```typescript
export type Interruptible<T = unknown> = T & {
  signal?: AbortSignal | undefined;
  timeout?: number | undefined;
};
```

`SQLiteQueryOptions` and `SQLiteChunkOptions` drop the `timeout` they declare today and
inherit it. `SQLiteTransactionOptions`, `SQLiteBulkWriteOptions` and `SQLiteOutputOptions`
gain it by construction, with no member of their own.

The rename is visible in the published `.d.ts`. `OptionsWithSignal` is exported from
`api.ts`, which `index.ts` re-exports wholesale, and **it is in the rc.4 surface** — unlike
`timeout` and `QUERY_TIMEOUT`, this half of the change is a genuine break for a consumer who
names the type, and goes in `CHANGELOG.md` under Breaking. No alias is kept: one name, or
the pairing this design exists for stops being visible.

**`QUERY_TIMEOUT` becomes `OPERATION_TIMEOUT`.** It is raised by seven methods now, only
five of which run a query. `TIMEOUT` is not reused: it is published, and it means a deadline
on the library's own lifecycle work — a worker that never became `ready`
([`src/client.ts`](../../../src/client.ts)), a `deleteDatabase` that did not complete
([`src/delete.ts`](../../../src/delete.ts)). Conflating them would force a `catch` to read
the message to know which it holds; this is the argument that already separates
`DATABASE_IN_USE` from `BUSY`.

**`SQLiteError` gains `readonly timeout?: number`** — the budget that was exceeded,
alongside the existing optional `sqliteCode`, following the same house style rather than a
new subclass. It carries the number a log needs without parsing the message.

**`inspect()` remains the documented exception.** It takes no `signal` and takes no
`timeout`: `navigator.locks.query()` takes no lock and waits for nothing, so either option
could only abort a `.then()`.

## 4. The mechanism

At the top of each public method, before any `await`:

```typescript
const ctrl = new AbortController();
const timer = setTimeout(
  () => ctrl.abort(new SQLiteError('OPERATION_TIMEOUT', message, { timeout })),
  timeout,
);
const { signal, release } = mergeSignals(options?.signal, ctrl.signal);
```

**The reason IS the error.** `mergeSignals` relays `source.reason` verbatim
([`src/utils.ts`](../../../src/utils.ts)), and every abort path in the library already
rejects with `signal.reason` — `makeAbortRace` in
[`src/queries.ts`](../../../src/queries.ts), the transaction's race and its inner
`withSignal`, the bulk writer's per-batch checks, `acquireInstrumented`'s guard. So the
`SQLiteError` arrives at the caller through machinery that already exists, with **no
translation layer, no catch-and-rethrow, and no place that has to ask which signal fired.**

Three properties fall out of *where* the controller is created:

- The clock starts at the call, so it covers the wait for a lease, the cross-tab write
  lock, the barrier drain and the worker round trip — everything the execution budget
  excluded.
- It covers the caller's own pauses. A `stream()` whose consumer sleeps between pulls is
  charged for the sleeping, which is what "a deadline on my call" means.
- The teardown is owed anyway: `clearTimeout(timer)` goes wherever `release()` already
  goes.

**What is deleted, not moved.** The worker stops knowing about budgets entirely:
`timeout` leaves the wire message in [`src/types.ts`](../../../src/types.ts), and `spent`,
`stepStart`, `overBudget()` and `WorkerQueryTimeout` leave
[`src/worker/worker.ts`](../../../src/worker/worker.ts). The progress handler stays — it is
what carries an abort into a running `step()` — but is now installed for the signal paths
alone. Its `SQLITE_INTERRUPT` catch loses its third trigger: both survivors mean "the client
has already rejected", so the branch is always `break` and never `throw`.

**Per method**, the composed signal replaces `options.signal` and nothing else changes:
`read`, `write`, `first`, `chunk` and `stream` already thread it to `acquireInstrumented`
and to the worker; `transaction()` already merges its signal into every inner statement and
races the callback itself, with `ROLLBACK` behind it
([`src/transaction.ts`](../../../src/transaction.ts)); `bulkWrite()`/`output()` already
consult it between batches.

## 5. Decisions

**D1 — Wall clock from the call, not from the first `step()`.** A variant was considered
that would start the clock when SQLite first gets the floor, keeping the anti-contention
property. Rejected: it is a start instant the consumer cannot observe, so it trades one
unpredictability for another. `timeout: n` means *n milliseconds after I called*.

**D2 — The library owns the controller, so the reason is the error.** `AbortSignal.timeout()`
is not used: it offers no way to set the abort reason, and its `DOMException TimeoutError`
would have to be recognised and translated somewhere. Owning an `AbortController` and a
`setTimeout` costs three lines and removes that somewhere entirely.

**D3 — An external `signal` keeps rejecting with `signal.reason`, verbatim.** No
`OPERATION_ABORT`. The rule that decides is **who owns the signal**: when the caller supplies
it they already own the rejection value — `controller.abort(new MyDomainError(...))` must
come back untouched, as `fetch()` and every `AbortSignal` consumer on the platform
guarantees, and as the TSDoc on this very type already promises ("your reason, not an error
of this library's making"). When the library creates the signal there is no caller reason to
preserve, so minting a typed error takes nothing away. The asymmetry is not an
inconsistency; it is that rule applied twice.

**D4 — One accepted wart.** `signal: AbortSignal.timeout(1000)` rejects with a
`DOMException TimeoutError` while `timeout: 1000` rejects with `OPERATION_TIMEOUT` — two
errors for one event, chosen by which knob the consumer turned. Unifying them would mean
inspecting `reason.name === 'TimeoutError'`, which would hijack a `DOMException` a caller
passed deliberately. The wart is cheaper than the hijack.

**D5 — `timeout` is the only new property on the error.** `elapsed` is worth nothing: by
construction it is always `timeout + ε`. A `phase: 'queued' | 'running'` field was proposed
and closed as YAGNI (user, 2026-09-07) — see §7.

**D6 — The same limitation for `signal` and for `timeout` on `sync` without isolation
(user, 2026-09-07).** Today `timeout` stops a running statement on every build, because a
budget needs no channel: the worker receives it with the request and reads its own clock.
The alternative examined was to keep that by enforcing the deadline on both sides, the
client's signal being authoritative for the promise and a worker-side `now() > deadline`
stopping the statement where a signal cannot. It was declined in favour of the symmetric
behaviour: on `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS` and `MemoryVFS`
on the `sync` build without cross-origin isolation, **a `timeout` now stops the wait and not
the work, exactly as a `signal` does.** The escape hatch is unchanged and costs no hosting
change: those four accept `build: 'async'`.

This is a capability reduction against `main`, and it is deliberate. It was never released.
What it buys: `API.md` describes interruption with one table covering both options instead
of a table plus a paragraph explaining that `timeout` is different, and the worker's
interrupt handling collapses to a single meaning.

**D7 — No accumulation across calls, because there is nothing to accumulate.** The
cross-call execution budget the backlog entry anticipated — the worker reporting `spent` in
its `done` message, the client subtracting — is not built. A wall-clock deadline is one
timer at the entry point, whatever happens under it.

## 6. What this promises, and what it does not

1. **The promise settles within `timeout` of the call**, on every build and every VFS. This
   is unconditional; it is D1 of the interruption design, which is unchanged.
2. **The work stops too, wherever a `signal` stops it** — the `async` and `jspi` builds
   anywhere, the `sync` build on a cross-origin-isolated page. Nowhere else. §5 D6.
3. **A timeout can kill a call that never reached SQLite.** Under cross-tab contention a
   call may spend its whole budget waiting for the write lock. This is the property the
   execution budget bought, given up knowingly: a deadline the consumer can predict is worth
   more than one that excuses queueing. A consumer who wants to know which it was reads
   `db.debug`, not the error.
4. **A `bulkWrite()`/`output()` timeout lands between batches, never inside one**, exactly
   as an abort does — the existing TSDoc on the type covers both without a word changing.
   Batches already written stay written; an aborted `output()` remains observationally a
   no-op.
5. **A `transaction()` timeout rolls back.** The existing race and its `ROLLBACK` do the
   work; a rollback that itself fails still evicts the worker.
6. **The timer is a browser timer.** A background tab throttles `setTimeout`, so a deadline
   may fire late there. `AbortSignal.timeout()` has exactly the same behaviour, so this is
   not a cost of the sugar — but it is documented, because "wall clock from the call" invites
   the assumption that it is not.

## 7. Out of scope

**`phase: 'queued' | 'running'` on the error — closed, not deferred (user, 2026-09-07).**
It would recover the diagnostic the execution budget gave for free: whether the call was
still waiting for a lease or genuinely executing. The client can distinguish them, and
nothing else says so after the fact. Judged YAGNI: nobody has asked. **It is closed here
rather than routed to `mem:follow-ups`** — a backlog entry for an idea with no demander is
noise, and this section is the destination that a future reader of this design will
actually reach.

**Cross-call execution budgets** — D7.

## 8. Tests

Falsifiability is named per test, and `mem:lessons` applies twice over: *a test that
measures the END of a query cannot pin an INTERRUPT*, and *a streaming test must `await` in
its loop body*.

**Inverted.** `tests/browser/query-timeout.test.ts`'s third test — "does not charge the
consumer for its own slowness" — asserts today that a 150 ms sleep between chunks against a
100 ms budget does **not** reject. Its premise is reversed by this design: it must now
reject with `OPERATION_TIMEOUT`. The comment explaining the old falsifier is rewritten, not
deleted; a test whose reasoning is stale is worse than no comment.

**Kept, renamed only.** The first two tests of that file — the statement really stops, and
the budget is not per statement — hold unchanged under wall clock. The second keeps its
value: two statements whose sum exceeds the budget still reject.

**New.**

- **A timeout that fires while the call is still queued.** `poolSize: 1`, one long query
  holding the only worker, a second call with a short `timeout` that never reaches a
  `step()`. Falsifier: move the controller's creation below the lease acquisition and the
  test goes green for the wrong reason — it must be green *because* the clock ran during the
  wait.
- **One test per newly-covered method** — `transaction()`, `bulkWrite()`, `output()` —
  asserting `OPERATION_TIMEOUT` and, for the transaction, that the database shows no trace
  of the rolled-back work.
- **A caller's `signal` still wins with its own reason** when both are supplied and the
  caller aborts first. This is what pins D3 against a future "unify the errors" edit.

**Not asserted, and said so in the test file.** That a `timeout` stops the *work* on a given
build: that is the interruption lot's subject, its tests already exist, and this design
changes nothing about the mechanism they cover.

## 9. Documentation

The generalization touches more prose than code. `mem:lessons` on renaming a heading applies:
`grep -rn 'Interrupting a query' .` before moving anything.

- **`API.md`** — eight option tables document `signal`; five of them document `timeout`.
  Those five rows are rewritten, and the tables for `transaction()`, `bulkWrite()` and
  `output()` gain a `timeout` row. Their `signal` rows already exist and are worded per
  method ("Abandons the transaction. Rolls back…"); the new `timeout` rows follow that,
  rather than repeating one generic sentence three times. The *Interrupting a query* section
  collapses to one table covering both options, losing the paragraph that claimed `timeout`
  "works on every build". The `QUERY_TIMEOUT` row of the error table is renamed and
  rewritten.
- **`src/api.ts`** — the TSDoc on `Interruptible`, which is the one place `signal` is
  documented and from which every option type inherits it, gains the `timeout` sentence.
  Both existing per-type `timeout` comments are deleted with the members they annotate.
- **`CHANGELOG.md`** — the `timeout` and `QUERY_TIMEOUT` entries in `## Unreleased` are
  **rewritten in place**, not superseded by a new entry: they describe a behaviour no
  release ever carried, and leaving both readings in one section would publish a
  contradiction. The `OptionsWithSignal` → `Interruptible` rename is added under Breaking.
- **`README.md`** mentions neither option and is not touched. `VFS.md` is generated and is
  not touched: this is a property of the build, not of a VFS.
