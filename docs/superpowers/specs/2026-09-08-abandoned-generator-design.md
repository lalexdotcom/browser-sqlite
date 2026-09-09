# An abandoned `chunk()`/`stream()` generator returns nothing — design

**Date:** 2026-09-08 · **Status:** approved, unbuilt · **Target:** rc.5 · **Branch:** `fix/abandoned-generator`

A consumer who neither exhausts a `chunk()`/`stream()` generator nor calls `break` or
`.return()` abandons it. Three `finally` blocks then never run, and the worker they would
have released stays leased and parked for the life of the page. This design adds a
`FinalizationRegistry` safety net that performs, at collection time, what the lost `finally`
would have performed.

Scheduled by the user on 2026-09-08 as a session of its own, and named in `mem:state` as the
last thing before rc.5.

---

## 1. The defect, verified against the source

A generator suspended at a `yield` replays its `finally` only if it is resumed or if
`.return()` is called on it. The GC does not do it. Three `finally` blocks sit on this path
and none of them runs:

| Where | What is lost |
|---|---|
| `src/client.ts:1018-1020` / `:1039-1041` | `release()` from `withDeadline` — the `timeout` timer, and the listeners `mergeSignals` attached to the caller's own signal |
| `src/client.ts:963-968` | `lease.worker.quiesce().then(release)` — **the pool lease** |
| `src/queries.ts:67-75` | `teardown()`, `worker.interrupt()`, `iterator.return()` — **the stop order sent to the worker** |

`mem:follow-ups` carried only the first two. The third is the heaviest.

**The worker is not merely leased, it is parked mid-statement.** The emission loop awaits
`gate.take(callId)` *inside* `for await (const chunk of query(...))` (`src/worker/worker.ts:514-520`),
a credit is issued only once the consumer has taken a chunk (`src/pool.ts:527-529`), and the
window is 2 (`src/credits.ts:15`). So after two unconsumed chunks the worker stops between two
`step()` calls, prepared statement live, implicit read transaction open. The only two things
that could wake it — a `credit` or a `stop` message — were both owed by the `finally` that did
not run.

**`DEFAULT_POOL_SIZE` is 2** (`src/client.ts:66`). Two abandoned generators are therefore
enough to wedge a client permanently: no lease is ever available again, and `read()`,
`write()` and `transaction()` all wait for ever. Nothing is logged and nothing throws.

**Documentation is not the fix.** `API.md` → *Queries* → *How they run* has told consumers to
exhaust or `break` since 2026-09-08. The library still wedges when they do not.

## 2. Why nothing but `.return()` can repair it

`pool.query`'s `yield chunk` is not inside a race. `interrupt()` sets `stopped` and resolves
`stopRequested` (`src/pool.ts:599-608`), but a generator suspended at a `yield` reads neither.
Resolving a deferred cannot reach it; only resuming it can, and the only resumption available
to code that does not hold the consumer's reference is `.return()` on the transport iterator.

**So the cleanup must hold a strong reference to the transport iterator.** That is safe, and
the reason is the same one that makes the whole approach feasible: references on this path run
downward only — consumer → `client.chunk` generator → `streamWithRetry` generator →
`queries.chunk` generator → transport iterator. Nothing in the worker or the pool refers back
up. Holding the transport therefore keeps none of the abandoned generators alive, and dropping
the outermost makes the whole chain collectable as a unit.

## 3. The mechanism

**A new module, `src/abandon.ts`.** Pure and Node-testable, the profile `src/credits.ts` and
`src/worker/cloneable.ts` already have and for the reason those files state. It owns one
`FinalizationRegistry` and exposes registration, unregistration, and an injectable `reclaim`
so that tests drive the cleanup without depending on the GC.

**`queries.chunk` becomes a factory.** Its present body moves into an inner generator; the
factory creates the transport iterator, creates the generator, and registers the pair:

```ts
export const chunk = (worker, sql, params, options) => {
  const iterator = worker.query(sql, params, { … });  // lazy: no postMessage before the first next()
  const token = {};
  const gen = drain(iterator, worker, options, token);
  registry.register(gen, { worker, iterator, release: options?.onAbandon }, token);
  return gen;
};
```

Registering the innermost generator is deliberate: `yield*` delegation makes the outer
generators hold it, so it becomes collectable exactly when the consumer drops the outermost
one — which is the event this design is about. It also covers both entry points at once,
since the client path and the transaction path both bottom out here.

The existing `finally` gains one line, `registry.unregister(token)`, so a generator that ended
by any ordinary route — exhaustion, `break`, `throw`, `.return()` — leaves nothing registered.

**`reclaim` does what the lost `finally` does, in the same order and for the reason its comment
already gives** — `interrupt()` first, so the queued `return()` is not parked behind a `next()`
that will not settle:

```ts
if (state.started) worker.interrupt();
void iterator.return(undefined).catch(() => {});
release?.();   // the owner's part
```

**`interrupt()` is guarded, and the guard is not a precaution.** It acts on whatever query
the worker is running *now* and cannot know which query asked for it. A generator created and
dropped without ever being started holds no query — and on the transaction path that worker is
meanwhile serving the rest of the callback, so interrupting on its behalf would abort a
healthy, unrelated statement. `state` is a plain `{ started: boolean }` the generator sets and
the held value reads; it points nowhere upward, so it does not defeat collection.
`iterator.return()` needs no guard: on a generator whose body never ran it is a no-op, the body
having never entered its `try`. Found while writing the plan, not while designing.

**`onAbandon` composes by layer**, the pattern `withSignal`/`releasing` already use in
`src/transaction.ts`: each level wraps the callback it received with the resource it owns.

- **Client path.** `streamWithRetry` contributes the lease return; `chunk()` and `stream()`
  contribute `withDeadline`'s `release()`. `lease.release()` is already idempotent and
  generation-guarded (`src/scheduler.ts:310-323`), so a double call is inert.
- **Transaction path.** `onAbandon` is only the `withSignal` merge teardown. **No lease
  handling at all**: `iterator.return()` runs `pool.query`'s `finally`, which resolves `idle`,
  which settles the `quiesce().then(release)` already pending in the transaction's own
  `finally` (`src/transaction.ts:302-315`).

## 4. Decisions

**D1 · The registry half is best-effort, and the documentation says so in those words.** A
`FinalizationRegistry` callback fires at a time the engine chooses, or never — an inactive tab
may not collect at all. On its own this design turns "wedged for the life of the page" into
"wedged until the next collection". It is not a guarantee and must not be described as one.
**D7 is the half that is deterministic**, and it is what the tests are built on.

**D2 · `if (signal?.aborted) throw signal.reason` stays inside the inner generator**
(`src/queries.ts:47`). Lifted into the factory it would throw at call time instead of at the
first `next()` — a behaviour change for `read()`, `first()`, `streamRows` and every transaction
method. This is the single most likely defect in the refactor and a test must pin it.

**D3 · The held value holds the transport iterator, and never the registered generator.** A
`FinalizationRegistry` held value that referred to its own target would keep the target alive
and the callback would never fire. `{ worker, iterator, release }` refers only downward.

**D4 · No `Symbol.asyncDispose` is added, because none is needed.** `[Symbol.asyncDispose]` is
on `%AsyncIteratorPrototype%`, every async generator inherits it, and its implementation is
`.return()` — which runs the very `finally` this design is about. Verified on this container's
Node 24.13.0: `await using` over a generator with a `finally` runs that `finally` on block
exit. The shipped build preserves this: `rslib.config.ts` is `syntax: 'esnext'` and
`dist/index.js` keeps native `async function*` with no regenerator helpers. **Where the engine
has the syntax, `db.stream()` already works with `await using` and there is nothing to ship.**

**D5 · No polyfill and no dependency.** `await using` is syntax; no polyfill adds syntax. A
consumer on an engine without it needs a transpiler plus, for the emitted lookup, something
like core-js — entirely in their own build. Ours must stay out of it: `package.json` has **no
`dependencies` at all**, which is a line of the verification baseline in `mem:state`, and a
library that installs `Symbol.asyncDispose` into someone else's realm decides for every other
package on the page. Support today, from BCD: `Symbol.asyncDispose` is Chrome 127, Firefox 141,
Safari *preview*, iOS **false**; `FinalizationRegistry` is Chrome 84, Firefox 79, Safari 14.1,
iOS 14.5.

**D6 · The reuse guard becomes a `SQLiteError` — new public code `GENERATOR_ABANDONED`.**
Today `src/pool.ts:456-457` logs to `console.error` and throws a bare
`Error('Worker is already processing a query')`, naming an internal invariant. Inside a
transaction that is the ordinary trajectory (§5), so it is the one place a consumer can meet
this defect and leave with something actionable. **The guard itself stays structural** — it
fires on "a query is already in flight on this worker", not on a diagnosis — but the only
reachable producer is an abandoned streaming generator, and the message says so and names
`break` / `.return()`. This mirrors how lot 10 kept `errorCode` on the worker protocol: a
structural check, documented as such.

**D7 · An abort reclaims, it does not merely reject.** Today a `signal` or a `timeout` firing
on an abandoned generator does nothing at all: `makeAbortRace` rejects `aborted`, the generator
is suspended at a `yield` rather than on the race, and `aborted.catch(() => {})`
(`src/queries.ts:23`) swallows it. So `reclaim` is also invoked from the abort path. This is
not a new promise — since lot 10 `timeout` is a wall-clock deadline counted from the call, so a
generator still suspended at the deadline is already expired by contract; that contract is
honoured today for a live generator, whose next `.next()` rejects with `OPERATION_TIMEOUT`, and
silently broken for an abandoned one. D9 makes the two agree. The double teardown is inert:
`iterator.return()` twice is a no-op and `lease.release()` is idempotent
(`src/scheduler.ts:310-323`). **It carries no consumer documentation** (user, 2026-09-08): the
case is too narrow to earn a line in `API.md`, and advising a `timeout` as leak protection
would invert what the option is for.

**D8 · `FinalizationRegistry` joins `LIB_REQUIRES`** in `scripts/render-vfs-matrix.ts`. It sits
below the current floor (~Chrome 92, from `crypto.randomUUID` and `Array.prototype.at`), so no
published number should move — **which is verified by re-rendering the tables and diffing, not
by this paragraph.** The list exists to state what the bundle actually uses; the
`structuredClone` trap in `mem:follow-ups` is about APIs that *raise* the floor, and this one
does not.

## 4b. Retraction, 2026-09-08, from the whole-branch review

Two arguments above did not survive the build. They are corrected here rather than
deleted, per this repository's convention of keeping refutations.

**§3's guard is wrong, and so is the question it asks.** `state.started` answers *did
this generator ever run*; the question the cleanup must ask is *is the worker still
serving this query*. The two differ because `done` clears `deferredChunk` from the
message handler while the transport generator is still suspended at its `yield`: the
reuse guard then lets the next statement through, the transaction commits normally —
so §3's "no lease work here, the transaction still holds the worker" does not hold —
and the lease goes back to the pool with a stale transport parked on it and the
caller's abort listener still armed on a signal the caller owns. A later abort then
reached a live, unrelated query: `interrupt()` broke its loop and its consumer
received 100 of 4000 rows with no error, the same defect this design exists to fix,
in mirror image. Bisected against `main`.

What ships instead: the pool records **which** transport generator it is serving,
`interrupt()` is named with the transport being stopped and is a no-op otherwise, the
transport's own `finally` runs only while it still owns the worker, and the cleanup
carries its own `detach` and runs at most once by any route. Pinned by
`tests/browser/abandon.test.ts` → *a reclaim that arrives late*.

**D6's "the only reachable producer is an abandoned streaming generator" is false.**
Two overlapping `tx.read()`s reach the guard with no generator anywhere, and so does a
`tx.bulkWrite` batch still in flight (`tests/browser/multi-client.test.ts`). The
message now leads with the structural fact and names the generator as the usual cause.
The error **code** is unchanged: renaming a public code is a separate decision.

## 5. What this promises, and what it does not

- **No time bound.** See D1.
- **A generator abandoned while a `next()` is in flight is unreachable by the registry, and
  that state is transient.** Measured 2026-09-08 on Node 24 under `--expose-gc`, not reasoned:
  suspended at a `yield` it is collected; with a `next()` still in flight it is **retained**,
  because the transport's pending promise chain runs from the worker down to its resumption;
  and **the moment that `next()` settles it is collected**. The two states are complementary,
  which is why this costs nothing: while the `next()` is in flight the worker is busy on the
  consumer's behalf and there is nothing leaked to reclaim. The leak begins only once a chunk
  has been delivered and nobody takes the next one — which is exactly the state where the
  generator is collectable. D7 covers the in-flight window anyway, and deterministically.
- **On the transaction path it repairs the permanent case and not the loud one.** The `reclaim`
  fires at collection; the callback's next statement — and at the latest the auto-COMMIT, which
  reaches `worker.query` through `exec` → `readWorker` — almost always arrives first, trips the
  guard, fails the rollback the same way, and reaches `onPoisoned` → `handleDeath`
  (`src/client.ts:1320`), which terminates the worker and restarts the slot. That trajectory
  remains. What D6 changes is the quality of the failure, not the failure. What §3 repairs is
  the case where the transaction has ended and its pending `quiesce()` would never settle.
- **A worker killed on the transaction path releases its OPFS handle and its read
  transaction**, because the thread dies. The parked-handle exposure is therefore a client-path
  concern only.
- **Nothing changes for a correct consumer.** Exhaustion, `break`, `throw` and `.return()`
  already run all three `finally` blocks. `read()` and `first()` buffer and were never exposed.

## 6. Out of scope

- **Any watchdog on consumer slowness.** A deadline on the gap between two `next()` calls would
  break the legitimately slow consumer `chunk()` exists for, and `mem:lessons` already records
  that shape: *a timeout budget can reintroduce the failure a helper was written to prevent*.
- **Returning the lease across the suspension.** A prepared SQLite statement lives in its
  worker; releasing the lease while the consumer is suspended means either buffering the whole
  result — which is what `chunk()` exists not to do — or re-lending a connection with an open
  transaction. Rejected explicitly rather than left unsaid.
- **A `databaseExists`-style probe for pool exhaustion.** `db.debug` and `inspectDatabase`
  already report worker state; nothing new is exposed here.

## 7. Tests

**Node, deterministic — `src/abandon.ts` with an injected `reclaim`, a stub worker and a stub
iterator.** The factory registers; an ordinary exit unregisters; `reclaim` performs
`interrupt`, `return` and the owner's `release`, in that order. Every falsifier is **run** —
delete the line, observe red, restore, observe green — and reported, not reasoned. `mem:lessons`
is explicit that four of wave 3's reasoned falsifiability claims were wrong.

**Node, deterministic — D2.** A `chunk()` called with an already-aborted signal must reject on
the first `next()` and must not throw at call time. This is the refactor's most likely defect.

**Browser, deterministic, no GC.** `.return()` on a `stream()` frees the lease and leaves the
worker `READY`; the same through `[Symbol.asyncDispose]()`, behind a feature test, since it is
literally the same path. This pins the two doors `API.md` is about to name — the answer to
*a documented instruction that nothing exercises will drift*.

**Browser, deterministic — the D9 path, which is the important one.** An abandoned generator
with a short `timeout` must give its worker back at the deadline: the lease returns, the worker
reports `READY`, and a later query is served by it. This exercises the whole repair —
`interrupt`, `return`, the owner's `release` — end to end, on both engines, with no GC and no
flag. **It is the test the design should be judged on**; the one below is a bonus.

**Browser, real GC — one Chromium test, and it may not survive.** Launched with
`--expose-gc`, skipped when `gc` is absent, with a bounded retry loop rather than a single
collection. It is to be run **13 times** before being believed, this repository's own bar from
the `barrier` campaign. If it flakes it is deleted, and a comment says plainly what is pinned
and what is not — the discipline the interruption lot adopted for its three tests.

**A streaming test must `await` in its loop body.** The dropped-chunk defect of 2026-09-04
survived four releases because every test consumed at full speed; the abandonment tests here
must not reintroduce that shape.

## 8. Documentation

- **`API.md` → *Queries* → *How they run*.** Name `.return()` beside "exhaust or `break`" as
  the deterministic door, add that `await using` works wherever the engine has the syntax with
  nothing to install, and say that an abandoned generator is recovered only at collection —
  best-effort, not immediate.
- **`GENERATOR_ABANDONED`** joins the error-code table.
- **The two paths stop being interchangeable, and `API.md` says today that they are.**
  `API.md:215` states that `tx` carries "the same querying surface as the client". After this
  change an abandoned generator is recovered silently on the client path and, on the
  transaction path, kills the worker and fails the transaction with `GENERATOR_ABANDONED`.
  One sentence, in *How they run* or in the transaction section, must say so.
- **`VFS.md` and the generated tables are part of the verification, not of the prose.** D8
  feeds `LIB_FLOOR`, which caps every VFS cell and the build table across the fourteen
  generated zones of `VFS.md`. Run `pnpm docs:vfs` and diff: **the expected diff is empty, and
  a non-empty one is a finding, not a rubber stamp.**
- **No measurements in the three consumer pages** (user, 2026-09-08).
- **`CHANGELOG.md`.** A new public error code and a fixed leak are both consumer-visible.
  Opening an unreleased section is the user's instruction and is not inferred here
  (`mem:state`, `mem:conventions`).

---

## Amendments made during implementation — 2026-09-08

The original decisions above are left as written. Two of them were wrong, and this section
says how, because a spec that quietly edits its own mistakes teaches nothing.

### A1 · §3's reasoning about the transaction path was wrong, and it cost a Critical

§3 argued that the transaction path needs no lease work because "the transaction owns the
lease", and D7 attached an abort listener on the strength of it. Both assumed the transaction
is still holding the worker when a cleanup fires. **It is not, in the branch that matters.**
`done` clears `deferredChunk` while `drain` is still suspended at its `yield`, so the reuse
guard never trips, the transaction commits normally, and the worker goes back to the pool
with a stale transport suspended and the D7 listener still armed on a signal **the caller
still owns**. When that caller later aborts its own controller, the cleanup fires against a
worker serving somebody else: `interrupt()` breaks the live query's loop and its consumer
receives `done` with short rows and no error, while `iterator.return()` resumes the stale
transport, whose `finally` then resets the live query's `deferredChunk`, `inbox`, `idle` and
status.

**It was a new silent row-loss regression** — 100 rows of 4000 — of exactly the class this
design exists to remove. Found by the whole-branch review, bisected against `main`, and
reproduced without a garbage collection or a browser flag.

**What the code does now.** The pool records **which transport generator it is serving**;
`interrupt(on)` is inert unless the worker still serves `on`; the transport's own `finally`
runs only while it owns the worker; and the cleanup carries its own `detach` and runs at most
once. `state.started` is gone — it answered "did this generator ever run", which was never
the question. The question is "is this still the query the worker is serving", and identity
answers it without a new channel between the pool and `abandon.ts`, because the transport
object is already in the cleanup's hand as the `iterator` D3 requires.

**A consequence, measured rather than assumed:** an abandoned generator inside a transaction
now costs a worker restart where it previously did not, because the `ROLLBACK` trips the
guard in turn and `onPoisoned` evicts the slot. That is correct — the connection genuinely
holds an open transaction with a query in flight — and it recovers on the worst-case VFS:
`AccessHandlePoolVFS` at `poolSize: 1`, where the exclusive OPFS handle must be released
before the replacement can open, comes back in 43 ms on Chromium and 57 ms on Firefox.

### A2 · D6's premise was false, and the repository already said so

D6 asserted that the only reachable producer of the reuse guard is an abandoned streaming
generator, and let the message state that as a diagnosis. **Any two overlapping statements on
a transaction's worker trip the guard** — `Promise.all([tx.read(…), tx.read(…)])` reproduces
it with no generator anywhere. Worse, `tests/browser/multi-client.test.ts` already recorded a
second producer, a `bulkWrite` batch in flight, "caught under load after passing in
isolation". The evidence predated the decision by weeks.

The code name stays. The message now leads with the structural fact — the worker already has
a query in flight, and a transaction's statements must not overlap — and names the generator
only as the usual cause. `API.md`'s row matches.

### A3 · `API.md` had dropped §5's hedge

§5 says the loud trajectory "almost always" arrives first. `API.md` promised it
unconditionally, which told readers the dangerous case was loud when it is the silent one.
The hedge is restored and is true of the code as built.

### A4 · `Promise.race` ties resolve by array position

`drain` races the pending chunk against the abort. Once the cleanup's `iterator.return()`
completes the transport synchronously, both inputs are already settled on the next turn, and
`Promise.race` then resolves in **array order** rather than by settlement time — so the chunk
won, the loop saw `done`, and the abort was lost outright rather than delayed. The order is
now `[aborted, iterator.next()]`. `writeWorker` carries the same shape and is safe as it
stands: nothing external can complete its transport while its own race is outstanding.

### A5 · Four claims above are retracted, and the Firefox measurement is why

Retracted rather than edited, per this section's own rule. All four rest on one false
premise, and it is the premise that hid the wedge.

**§5, lines 229-231 — "A worker killed on the transaction path releases its OPFS handle and
its read transaction, because the thread dies. The parked-handle exposure is therefore a
client-path concern only."** False. A terminated worker does **not** reliably release a
rotated exclusive OPFS sync access handle on Firefox, and the pool then wedges: the
replacement cannot open the file. Measured, not reasoned — and the measurement is the reason
this branch's last commits exist.

| VFS | Chromium | Firefox |
|---|---|---|
| `OPFSCoopSyncVFS` — rotates the handle always | 0/40 | **9/40 (22 %)** |
| `OPFSAdaptiveVFS` — rotates it in degraded mode | 0 (suite always green) | ~3 % (3 in ~36 chain runs; 1/8 and 1/50 under load) |
| `OPFSWriteAheadVFS` | — | **0/160** |
| `IDBBatchAtomicVFS` — no handle at all | — | 0/40 |

`main` measured 0/40 against this branch's 5/40 on the same probe; one failure surfaced
`No modification allowed`, which names the handle directly.

**`OPFSWriteAheadVFS` was predicted affected and measured not to be**, and the prediction is
worth keeping because of how it failed. It was inferred from `mem:vfs`'s "degrades exactly
like `OPFSAdaptiveVFS`" on Firefox — read as a statement about **handle ownership** when it is
a statement about **concurrency**. "No concurrency" and "one exclusive handle rotated between
connections" are different properties, and collapsing them cost a cell that was then measured
at 0/160 (P(0/160) at Adaptive's ~3 % is 0.7 %). The mechanism is therefore *"VFS that rotate
a single exclusive sync access handle between connections"* — CoopSync always, Adaptive in
degraded mode — and never *"VFS without concurrency"*. Of the two recommended VFS, exactly one
is exposed.

**§5, lines 222-228 — "That trajectory remains. What D6 changes is the quality of the failure,
not the failure."** No longer true. `5df3c03` closes what the callback abandoned before the
transaction commits or rolls back, so the guard is not tripped, the ROLLBACK does not fail, and
`onPoisoned` evicts nothing. The trajectory is gone, not merely relabelled.

**§8, lines 287-290 — the mandated documentation sentence, that the transaction path "kills
the worker and fails the transaction with `GENERATOR_ABANDONED`".** `API.md` now says the
opposite, and correctly: the generator is closed at the transaction's boundary and the
transaction commits. What still meets `GENERATOR_ABANDONED` is a statement issued **after** the
abandonment inside the same callback — the boundary is the guarantee, not the whole callback.

**A1's closing measurement — "it recovers on the worst-case VFS… 43 ms Chromium, 57 ms
Firefox".** It recovers where it was measured, and the measurement was taken on a VFS and an
engine pair that does not strand the handle. On Firefox with a rotated handle it does not
recover at all, which is the whole content of the table above. `mem:measurements` →
ABANDON-RESTART carries the same supersession.

The sentence the measurement qualified is retracted with it, not only its number. A1 also
said "an abandoned generator inside a transaction now costs a worker restart where it
previously did not, because the `ROLLBACK` trips the guard in turn and `onPoisoned` evicts
the slot." That is the same trajectory the "trajectory remains" paragraph above was retracted
for: once the transaction closes what the callback abandoned before it commits or rolls back,
the guard is not tripped and the `ROLLBACK` does not fail on that account. A worker restart is
still possible on this path — `closeOpenStatements()` in `transaction.ts` documents the wait
and the eviction that can follow it — but not for the reason A1 gave, and not as a certainty.
