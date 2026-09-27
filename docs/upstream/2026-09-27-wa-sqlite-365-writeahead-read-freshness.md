# wa-sqlite #365 — a read that starts before the news of a commit

*2026-09-27 — measured on Chromium 151, in the container*

[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365

**Why this is here.** On `OPFSWriteAheadVFS`, one of the two VFS this library recommends, a read issued right after another worker's write resolved could return the database as it was before that write. The library's commit-propagation barrier hid it, but by timing only: remove the barrier and put the machine under load, and 37 of 616 probe tests read stale data on Chromium, against 0 with the barrier kept. The cause is in wa-sqlite's `WriteAhead.js`: a read transaction freezes a view that has not yet heard of the latest commit. Proposed upstream as [rhashimoto/wa-sqlite#365][pr365].

## How it was found

By asking whether the barrier still guards anything. `barrier.test.ts` had gone green with the barrier removed; its schema tests turned out to guard this library's column-name capture instead, and a data probe — seven write shapes, one and two clients, every pair — found 3 stale reads in 1232 without the barrier and none with it, too few to conclude (BARRIER-DATA in `mem:measurements`). Re-run under sixteen busy loops, it gave 37 of 616 without the barrier and 0 of 616 with it, on the same cells.

The stale cells carried many VFS names, and that misled for a while: a test that needs two workers falls back, on Chromium, to `OPFSWriteAheadVFS/sync` whenever its target cannot pool. Pinned per pair, only `OPFSWriteAheadVFS` went stale; `OPFSAdaptiveVFS`, `OPFSAnyContextVFS` and `IDBBatchAtomicVFS` read 0 of 30 each. Firefox is clean because this VFS has one connection there. The only other stale reads were `IDBMirrorVFS` between two clients, its documented exception.

## The mechanism, traced

A connection learns other connections' transactions from `BroadcastChannel` messages. `isolateForRead()` freezes the view as those messages have left it — its comment said so: "not guaranteed to be completely up to date" — while `isolateForWrite()` reads the WAL through its end.

A trace in the reader's worker, on the `WriteAhead.js` of before #355, with cross-context timestamps, ms from the write:

| t | where | event |
| ---: | --- | --- |
| 10.70 | writer | `tx` broadcast, transaction 3 |
| 11.30 | page | write resolved; reads issued |
| 11.80 | reader | query arrives |
| 11.90 | reader | `isolateForRead()` — view at transaction **2** |
| 12.20 | reader | `tx` for transaction 3 arrives, too late |
| 12.50 | page | read resolves `n = 1` |

The broadcast leaves the writer before its reply does, yet arrives after the read. The two travel different channels — `BroadcastChannel` for one, writer → page → reader `postMessage` for the other — and nothing orders them. SQLite cannot notice: page 1, change counter included, comes from the same stale view.

## Measured

`OPFSWriteAheadVFS/sync` on Chromium, one client, two workers, the barrier removed, sixteen busy loops, 100 iterations per arm:

- as shipped: **28/100** stale
- `isolateForRead()` reading the WAL to its end: **0/100**

An interleaved bisect of `WriteAhead.js` alone (three rotated rounds, 300 iterations per version): **15.0 %** before #355, **28.0 %** with it, **22.0 %** on upstream master, **22.7 %** with #361. The race predates #355, which about doubles it (≈3.9 σ) by a timing effect not traced — #355 fixed two other races, at open and at a WAL file switch. The first comparison, one run each, had read 9 against 28: the round-to-round spread is ±7 points, which is why arms are interleaved.

## Why it was this way

No rationale is written upstream, so this is a reading of the code. When `WriteAhead` was introduced, catching up with the WAL was asynchronous, while `isolateForRead()` runs synchronously on `jLock()`'s fast path, right after `acquireIfHeld('shared')`; and a reader behind corrupts nothing, where a writer behind would. Within one context the question does not arise — connections there share one `WriteAhead` view, which is also why the first version of the upstream test, two connections in one worker, passed on master. Catching up is synchronous today (`#readAllTx()` reads through the sync access handle), so the fast path can stay synchronous.

## Reproducible by the maintainer

`test/vfs_read_freshness.js` with a worker of its own, one connection per worker. The reader reads once, keeping its lazy read lock; blocks its event loop while the writer commits; and reads as soon as it unblocks, before its context delivers the broadcast. A guard checks the commit completed before the read began, so it cannot pass vacuously. On master: `Expected 1 to be 2`, 8 runs of 8, both builds. On the branch: 5 of 5, and the whole suite 15 files, 5794 passed.

Cost, 2000 read transactions on an idle database, three alternating rounds: asyncify 43 → 53 ms on average, about 5 µs per read transaction; jspi within the noise.

## Posted upstream

PR [#365][pr365], opened 2026-09-27 from `lalexdotcom:fix/writeahead-read-catches-up`, on `master` at `e6e01ae1`, which has #350, #357 and #361. **One commit, four files, +125 / −2.** Upstream CI on the head commit is green — [run 36347949523](https://github.com/rhashimoto/wa-sqlite/actions/runs/36347949523), `build (20.x)`, the only check.

It does not mention this library, per the standing rule: every figure in it is reproducible with wa-sqlite alone, and the load figures above are not quoted there.

## What stays ours

- **The carry.** In [`patches/`](../../patches) since 2026-09-27, to be dropped at the repin that brings it. With it, the probe above reads **0/100** stale under the same load, barrier removed, against 28/100 before.
- **The barrier's falsifier.** With the race understood it can be provoked on purpose, which the unloaded suite never did — the barrier has had no test that sees its absence.
- **The matrix's `needs` fallback**, which made a VFS's cell report another VFS's failures: whether the matrix should skip instead is the user's decision, open.
