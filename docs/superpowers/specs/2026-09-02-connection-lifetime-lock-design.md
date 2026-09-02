# The connection lifetime lock — design

**Date:** 2026-09-02 · **Status:** approved, unbuilt · **Target:** rc.5 · **Branch:** the cross-tab branch, continued

`deleteDatabase` destroys data under a live connection on three VFS. This design closes it for
all nine, with the same mechanism that already serializes writers — and in doing so replaces an
accidental protection with a declared one.

Sibling: `docs/superpowers/specs/2026-08-31-cross-tab-coordination-design.md`. This is the third
face of the same problem. Exclusion of writers and visibility of commits were the first two;
exclusion of *deletion* is this one, and it is a multi-client / multi-tab property in exactly the
same sense — "you cannot delete while a client is active" is a statement about the whole origin.

---

## 1. What is true today

Measured 2026-09-02, n=3 per engine, **identical on Chromium 151 and Firefox 153**. Full table in
`mem:measurements` under DELETE-LIVE.

| VFS | `deleteDatabase` under a live client | data destroyed |
|---|---|---|
| `OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`, `AccessHandlePoolVFS` | throws `WORKER_CRASHED` | no |
| **`OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`** | **resolves** | **YES** |

Three failure shapes, and the differences matter:

- **`IDBMirrorVFS` loses data silently.** After the delete resolves, the live client keeps serving
  its correct rows out of the in-memory mirror — no error, no signal — while a fresh client finds
  an empty database.
- **`IDBBatchAtomicVFS` is the most consequential**, being the only persistent multi-connection
  VFS that works on all three desktop engines. Its live client hangs on any subsequent read.
- `OPFSAnyContextVFS` at least errors immediately on the next read. The data is still gone.

**The four that survive, survive by accident.** The raw errors name `removeEntry` and
`createSyncAccessHandle`: it is OPFS access-handle exclusivity crashing the delete worker, an
operating-system-level constraint this library never arranged and cannot rely on. It disappears
for exactly the VFS that hold no exclusive handle — which is exactly the three that delete.

**`bsq:init` protects nothing here.** `worker/worker.ts` holds it across `open_v2` and the
PRAGMAs and releases it when the open finishes, so a live client holds no lock at all.

**The README currently promises the opposite, on both counts** — that an open database cannot be
deleted, and that `BUSY` is reported. Both are false. **The sentence is not to be corrected: it
is to be made true.** Deleting the promise instead of the defect would leave undocumented data
loss in place.

## 2. The mechanism

**Every client holds `bsq:conn:<ns>:<file>` for its whole lifetime.**

- **`shared`** normally, so any number of clients coexist.
- **`exclusive`** where `VFS_CAPABILITIES[vfs].exclusiveConnection` is declared — today
  `AccessHandlePoolVFS` alone, whose second client would otherwise open and then read nothing.
- **Not taken at all** where `sharesStorage(vfs)` is false: the memory VFS keep their pages in
  the worker that opened them, so two clients are two databases with nothing to exclude, and
  `delete.ts` already returns early for that layout.

**`deleteDatabase` requests the same name `exclusive`**, and fails with
`SQLiteError('BUSY', …)` when any client holds it.

The name, the namespace derivation, and the lock helper are the ones the cross-tab work already
built. **The `AccessHandlePoolVFS` guard shipped on 2026-09-01 stops being a special case and
becomes the exclusive mode of this lock** — one mechanism with two modes, rather than a general
rule with an exception beside it.

## 3. Decisions

**D1 · A client abandoned without `close()` blocks deletion, and that is correct.**
It *is* connected: its workers hold their handles and its pages are live. Deleting under it is
the data loss this design exists to stop, and the caller cannot be told apart from one that will
use the client again in a second. A killed tab has its locks released by the browser, so nothing
leaks past the tab's life — the same property `stagingLockName` already relies on. The remedy for
an application that leaks clients is `close()`, and the `BUSY` message says so.

**D2 · Both of `deleteDatabase`'s acquisitions are `ifAvailable`. Neither ever waits.**
`deleteDatabase` will hold two locks: `bsq:init` (already) and now `bsq:conn`. A client acquires
them in the opposite order — `bsq:conn` at construction, then `bsq:init` inside its worker's
open. **That is a lock-ordering inversion, and `ifAvailable` is what makes it harmless**: a
request that never queues cannot deadlock. This is an invariant, not an optimisation: a blocking
acquisition on either name reintroduces the cycle.

**D3 · A `shared` acquisition does not defer worker startup, and `bsq:init` is why that is safe.**
The `AccessHandlePoolVFS` guard defers spawning until its lock settles, because on Firefox a
worker that opens OPFS handles while another client holds them crashes before the guard can fire.
**That deferral stays confined to the exclusive mode.**

An earlier draft justified this by claiming a shared request never waits. **That was wrong.**
`deleteDatabase` *holds* its exclusive lock for the whole deletion, so a client constructed during
a delete does have its shared request queued behind it. `ifAvailable` stops delete from *queueing*;
it does not stop delete from *holding*.

What makes non-deferral safe is a different lock: **the delete holds `bsq:init` across
`runDelete`, and a worker takes `bsq:init` — blocking — before `open_v2`.** So a client
constructed mid-delete has its workers held at the open, by the mechanism that exists for exactly
this, whatever its `bsq:conn` request is doing. The startup path stays as GATE-1 describes it for
eight of nine VFS, and it stays correct for a reason that survives inspection.

**D5 · The two refusals get two error codes, because the remedies differ.**
`bsq:conn` refused means a client is open — possibly in another tab, possibly one the user must
close — and the new code **`DATABASE_IN_USE`** says so. `bsq:init` refused means an open or another
delete is in flight, which is transient, and keeps `BUSY`. The consumer's action differs
("retry in a moment" against "close it, and you may need a human"), so a message they cannot
branch on is not enough. Additive to the eleven existing codes, not breaking.

**`bsq:conn` is checked first**, so the more actionable and more likely cause wins when both would
refuse.

**D4 · Deletion fails fast where a write waits, and the inconsistency is deliberate.**
A second writer is doing work the caller wants done, and ordering it is a service. A delete under
a live connection is a mistake the caller should learn about at once — and waiting would mean
waiting for a client's lifetime, which belongs to the application, not to a queue. The README
already promises `BUSY`; this makes it true.

## 4. What this does not cover

- **A connection outside this library** — another library, or native code on the same origin.
  Nothing at our layer sees it.
- **A client whose tab is alive but which the application has forgotten.** By D1 it blocks
  deletion, deliberately. That is a leak in the application, and it is visible as a `BUSY` that
  does not clear.
- **The four VFS that were accidentally safe do not become safer.** They were already refusing;
  what changes is that they refuse *by design* and report `BUSY` instead of `WORKER_CRASHED`.

## 5. Deliberately out of scope: counting clients

Measured 2026-09-02, both engines: `navigator.locks.query()` reports **one entry per shared
holder** — N holds give N entries at N of 1, 2 and 4, same-realm and cross-realm. So once this
lock exists, the number of clients on a file is `query()` filtered by name, and the number of
*tabs* is the count of distinct `clientId` on those entries, because **`clientId` is realm-scoped,
not hold-scoped**. Swapping the two undercounts or overcounts silently.

That is a real capability an application would want — "this database is open in another tab" — and
it is **not built here**. The fix stands on its own and is urgent; the API deserves designing once
the lock's cost is known in real use rather than in a probe. `mem:measurements` carries the
numbers so no re-measurement is needed to pick it up.

## 6. Testing

**The falsifier is the measured defect itself.** For each of the three VFS that delete —
`OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS` — a test opens a client, writes a row,
calls `deleteDatabase` with the client still open, and asserts `BUSY`. Remove the guard and each
goes red, because each currently resolves. **That must be verified by experiment, not by
argument:** five reasoned falsifiability claims in this repository have turned out false when
actually tested, and one of them was in the sibling spec's own plan.

Also required:

- **The four accidentally-safe VFS now report `BUSY`, not `WORKER_CRASHED`.** That is a
  consumer-visible error-code change and belongs in the CHANGELOG.
- **A control:** after `close()`, `deleteDatabase` succeeds on every VFS. If a control fails the
  suite is measuring something else.
- **A control on concurrency:** two clients still coexist on the non-exclusive VFS. The lock must
  not have become exclusive by accident.
- **The memory VFS take no lock**, asserted rather than assumed.
- **No test may depend on a wall-clock race.** This branch lost a full cycle to one that did.

## 7. Answered while writing this, and worth keeping

**`bsq:init` is not redundant, and an earlier draft of this spec was wrong to suspect it might
be.** Two jobs, neither substitutable:

- `bsq:init` is a **mutex between openers**. Two workers of one pool must not open the same file
  at once — without that serialization, two Firefox runs in three ended with one worker opened out
  of four, permanently (`mem:measurements`, the readiness gate). A *shared* `bsq:conn` excludes
  nothing between clients and cannot do this.
- `bsq:conn` is a **marker of live connections**. `bsq:init` is released the moment an open
  finishes, so it cannot do this.

And for `deleteDatabase` specifically, `bsq:init` is what holds an in-flight open off during the
deletion — which is the half of the README's existing sentence that was always true, and what D3
now rests on.

The remaining question is the narrow one: whether a delete can slip between a client's lock
**request** and its **grant**. Reading the specification says no — the queue is FIFO per name, so
a request issued first is processed first and delete's `ifAvailable` meets a pending request and
is refused; and if delete's request came first there was no client to protect. **That is a reading
of a specification, not a measurement, and this repository has paid five times for exactly that.
It gets a test rather than a paragraph.**

## 8. Open, and not decided here

- **The client-count API of §5, together with the `debug` surface it belongs on** (user,
  2026-09-02). Deferred to its own session: the numbers are already in `mem:measurements`, so it
  can be picked up without re-measuring.
