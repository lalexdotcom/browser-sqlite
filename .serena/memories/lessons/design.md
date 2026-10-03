# Lessons — design of the library

Part of `mem:lessons`, which indexes every entry.

## Abandonment needs an owner, or every `await` is a hole — 2026-08-27

`ABORT-1` looked like "give `bulkWrite` and `output` a signal". Three separate
places consulted none, and **each was found by one more device run**, never by
a test in this repo:

1. `bulkWrite`'s chained batches called `write()` without the signal, so a batch
   already in flight could not be rejected.
2. `scheduler.acquire` took no signal at all — so while the pool had nothing to
   lend, an abort could not land for **any** method. This predated the abort
   work by a wave.
3. `applyBarrier` drained a query on the worker with no signal, inside
   `acquireInstrumented`, so every method passed through it.

The common fact is the lesson: **no single place owned "this call may be
abandoned"**, so any `await` without a signal was a hole, and holes surfaced one
engine at a time. Chromium never reproduced any of them — it always frees a
worker eventually — so the repo's own suite was green through all three.

The fix that ends it is placement, not plumbing: the guard sits in
`acquireInstrumented`, which covers the only phase of a call that was not
already abortable, so an `await` added there later is covered without being
remembered. A top-level race per method was considered and dropped as
redundant once that was true.

**Two reflexes this bought.** A green suite on one engine proves nothing about
a pool that can stay empty — the benchmark page is the reproducer, and the
campaign is the verification. And when a fix "should have worked" and did not,
the count matters: at three, stop patching and ask what the three have in
common.

## A deadline belongs to an operation CLASS, and abandoning a wait is not free everywhere — 2026-09-04

Two halves of the same mistake, both paid on the bench page's sweep.

**One budget for "storage calls" was wrong.** 2 s was chosen from "these are local operations
and 2 s is already generous", which is true of an OPFS `removeEntry` and false of an
`indexedDB.deleteDatabase`: on iPadOS Safari 27.0 the latter takes more than 2 s and less than
5 s after a completed run. The too-tight budget did not merely report a timeout — it made the
page abandon a store the run was about to need, and two columns then died at `opens` with 14
`not-run` cells behind them. **The standing hypothesis was that something held the store
permanently; it was simply slow.** Split the budget per operation class, then; a single
number covering two classes will be wrong for one of them.

**And abandoning a wait does not stop the work.** This project already knew that for
`close()` — `ColumnAbandoned` states it — but the consequence differs by API. An OPFS
`removeEntry` you stop waiting for holds nothing. An `indexedDB.deleteDatabase` stays queued
against that database, and IndexedDB processes a database's requests in order, so it BLOCKS
every later `open` of the same store. A comment claiming the abandoned promise "holds nothing
we need back" was written and shipped before this was noticed.

The general rule: **before bounding a call, ask what the abandoned request keeps doing**, not
just how long it usually takes.

## A wait you add must be owed by the statement that pays it — 2026-09-10

The transaction quiesce fix made every statement wait for its worker before resolving. Correct
for a statement that ran; **catastrophic for one that never started.** A statement refused by
`pool.ts`'s reuse guard has claimed nothing, so waiting for the worker parks its rejection
behind somebody else's query — and where that query is a generator the callback dropped, only
`closeOpenStatements()` will close it, at the end of the callback, which is exactly where the
rejection was heading. The two waited for each other and the test timed out at 30 s.

**It was found by a test written to pin a LIMIT, not to prove the fix.** The fix's own three
regression tests were green. What surfaced the deadlock was writing down "here is what A does
not cover" and asserting it — the boundary case, which nobody asks for and which is the only
thing that exercised the refused path.

**Two rules out of it.** When adding a wait to a shared resource, ask what the waiter has
actually acquired — a post-condition on work you did not do is a deadlock waiting for a
scheduler. And **pin the boundary of a fix, not only its subject**: the assertion "this case is
still broken, and cleanly" is where the second defect lives.

## A deadline "counted from the call" includes everything before the callback — 2026-09-10

A plan's test gave a transaction `timeout: 100` and waited on `tx.signal` inside the
callback. Green alone, red in the full suite: the deadline counts from the call, so the lease
and `BEGIN` spent it before the callback ran and the captured signal was never assigned. A
test around a wall-clock deadline must budget for what precedes the code it observes, and
assert its precondition — `expect(seen).toBeDefined()` — so a lost setup reports itself.

## What can run inside a WASM call depends on the build — 2026-09-15

The CoopSync hand-over fix first deferred the release to a microtask, argued safe: a `step` is one
synchronous call, and nothing else runs until it returns. True on `sync` and `async`, measured clean
there — and false on `jspi`, where wa-sqlite wraps every VFS import in `WebAssembly.Suspending`,
synchronous ones included, so pending microtasks run at each VFS call, mid-`step`. Firefox's `jspi`
still failed 9-18 times in 20 (COOPSYNC-HANDOVER, `mem:measurements`). **A claim about what can
interleave inside a WASM call is a claim about the build: measure all three, and give the test the
build that breaks the claim** — `coopsync-handover.test.ts` runs on `jspi` for exactly this, and a
mutation back to a microtask turns it red.

## A bound on the live set is not a bound on the process (2026-09-26, #361)

After rewriting the checkpoint around a bounded buffer, the reply said "about 67 MB down to 4 MiB" — computed from what the code holds, never measured. Measured (`RssAnon` over the browser tree, 5 ms samples): 48 MiB saved, and the plan still above upstream. A synchronous loop gives the GC no turn, so the peak follows the **volume allocated**, and upstream's one-page-at-a-time loop allocates 66 MB of garbage too. **A memory claim is a measurement or it is labelled as arithmetic** — same class as the 3365 ms of CHECKPOINT-DIRECT, a derived figure that read like a measured one.

## A backstop applied everywhere can break the VFS that use the signal it swallows (2026-10-01)

`busy_timeout` cured the `BUSY` two clients met on the WebLocksMixin VFS, where it means "another connection holds the lock". Applied library-wide, it hung `OPFSCoopSyncVFS`, whose `BUSY` means "give the event loop back so wa-sqlite can await the handle" — SQLite's busy wait inside the worker never returned there. One status code, two meanings by VFS: a setting that changes how SQLite answers a status goes per VFS, and the suite's full run, not a targeted probe, is what showed it.
