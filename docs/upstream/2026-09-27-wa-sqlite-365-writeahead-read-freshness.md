# wa-sqlite #365 — a read that starts before the news of a commit

*2026-09-27 — measured on Chromium 151, in the container. Revised 2026-09-28: the maintainer keeps eventual consistency by design, and the change is now opt-in, `PRAGMA read_to_current`.*

[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365
[answer]: https://github.com/rhashimoto/wa-sqlite/pull/365#issuecomment-5867434674

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

## The maintainer's answer: by design

rhashimoto replied the same day: read transactions being only eventually synced is the intended design, not a leftover. The selling point of write-ahead is that a write transaction, even a large and slow one such as a network sync, does not hold up reads on other connections. A read that scans the WAL to its end may read megabytes of frames of that write only to find no commit — and again on the next read. He chose less synchronization over that crosstalk, called the choice debatable, and suggested it could be a setting.

The code bears him out. `OPFSWriteAheadVFS` declares `SQLITE_IOCAP_BATCH_ATOMIC`, so a transaction writes its pages at commit — unless it outgrows SQLite's page cache (2 MiB by default), which then spills pages into the WAL through `#writePage` while the transaction is still open. `#readTx()` reads frame after frame from `#activeOffset` until a commit frame, and `#activeOffset` moves only past a complete transaction, so every read restarts from the same frame.

### The worst case, measured

Chromium 151, wa-sqlite's own runner, master against the unconditional change, both builds, three rounds alternating the order. Every build and round agrees within a few milliseconds.

**A — a transaction open and idle in another context**, pages of 4 KiB, default cache; 30 read transactions (`SELECT count(*)` on a one-row table), median per read:

| open transaction | master | read to current |
| ---: | ---: | ---: |
| 0 MB | ~0 ms | ~0 ms |
| 8 MB | ~0 ms | 12–13 ms |
| 32 MB | ~0 ms | 60–62 ms |
| 128 MB | ~0 ms | 252–265 ms, max 377 ms |

About 2 ms per MB open, paid by every read, since the median sits next to the maximum.

**B — a 128 MB transaction committed while another context reads in a loop.** The writer takes about 1.0 s alone and about 1.05 s with the reader, on either version: the writer does not pay. The reader completes about 51 000 reads on master and 130 to 240 with the change, some of them near 290 ms.

The bench is `test/zz-worst*` with its variants, kept outside the fork's tree in `.work/worst/bench/`, its logs in `.work/worst/`.

### Revised: opt-in

A second commit on the branch, `ac817fd6`, keeps master's behaviour by default. `WriteAhead` gains a `readToCurrent` option, `false` by default, and `isolateForRead()` reads the WAL to its end only when it is set; `PRAGMA read_to_current = 1` sets it per connection, and the bare pragma returns the current value, as `backstop_interval` does. The test sets the pragma in its worker. With it: 72 passed, 3 runs of 3, and the whole suite 5794 passed. With the pragma off, the test fails on both builds, `Expected 1 to be 2` — it still sees the race. Pushed and answered with the figures above in a [comment][answer], 2026-09-28.

## What stays ours

- **The carry.** In [`patches/`](../../patches) since 2026-09-27, to be dropped at the repin that brings it; since 2026-09-28 it carries the opt-in revision, which touches `OPFSWriteAheadVFS.js` as well as `WriteAhead.js`. With the pragma on, the probe above reads **0/100** stale under the same load, barrier removed, against 28/100 before.
- **Where the library sets it: in the barrier, 2026-09-28.** On `OPFSWriteAheadVFS` the barrier's read runs as `PRAGMA read_to_current=1; SELECT count(*) FROM sqlite_master; PRAGMA read_to_current=0` (`catchUpPragma` in `VFS_CAPABILITIES`, `barrierSqlFor` in `src/epochs.ts`). The barrier runs only on a worker behind the commit epoch, so only the first read after a commit catches up, and reads during a large open transaction scan nothing; a consumer who sets `read_to_current` keeps their setting. Chosen over turning the pragma on for every read, measured in the library on Chromium, one client, two workers (`.scratchpad/365-lib-arms/`):

  | | stale, 16 busy loops | read, idle | 2 reads after a write | read, 32 MB open | read, 128 MB open |
  | --- | ---: | ---: | ---: | ---: | ---: |
  | no barrier, no pragma | 25/100, 26/100 | | | | |
  | pragma on every read, no barrier | 0/100, 0/100 | | | | |
  | barrier, as before | 0/100, 0/100 | 0.20 ms | 0.6–0.9 ms | 0.20 ms | 0.20 ms |
  | barrier with the pragma | 0/100, 0/100 | 0.20 ms | 0.9–1.0 ms | 0.2–0.3 ms | 0.20 ms |
  | pragma on every read | 0/100, 0/100 | 0.30 ms | 1.0 ms | 2.8–3.1 s | 11.4–11.8 s |

  Under 48 busy loops the barrier as before still read 0/100, so no load we could produce shows it failing; what the pragma adds is an ordering by construction, which wa-sqlite's deterministic test shows. The seconds in the last row are inflated by the test harness: rstest opens pages with Playwright's `newContext()`, an off-the-record context, where an OPFS sync-access-handle call costs 160–170 µs to read and about 290 µs to write, against 0.6 and 2.6 µs on a persistent profile with the same binary. The code is not transpiled and the volume scanned is the same as in wa-sqlite's runner; the time is in the `read()` calls. On an ordinary profile the cost would be wa-sqlite's ~2 ms per MB — still paid by every read while a large write is open, which the barrier avoids.
- **The barrier's falsifier.** With the race understood it can be provoked on purpose, which the unloaded suite never did — the barrier has had no test that sees its absence.
- **The matrix's `needs` fallback**, which made a VFS's cell report another VFS's failures: whether the matrix should skip instead is the user's decision, open.
