# Measurements — `OPFSWriteAheadVFS`: checkpoint, page size, read freshness

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## 365-LIB — `read_to_current` in the library: every read against the barrier's read, 2026-09-28, Chromium, this container

`OPFSWriteAheadVFS/sync`, one client, two workers, arms applied as patches in turn. Stale: one INSERT, two concurrent reads, 100 iterations, writer off index 0, sixteen busy loops (48 in the last column). Costs unloaded, medians over three rotated rounds. Every absolute time here is inflated by RSTEST-OTR; the arms share it.

| arm | stale /16 | stale /48 | idle read | 2 reads after a write | read, 32 MB open | read, 128 MB open |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| no barrier, no pragma | 25, 26 | | | | | |
| no barrier, pragma on every read | 0, 0 | | | | | |
| barrier as before | 0, 0 | 0 | 0.20 ms | 0.6-0.9 ms | 0.20 ms | 0.20 ms |
| barrier with the pragma | 0, 0 | 0 | 0.20 ms | 0.9-1.0 ms | 0.2-0.3 ms | 0.20 ms |
| pragma on every read, barrier kept | 0, 0 | | 0.30 ms | 1.0 ms | 2.8-3.1 s | 11.4-11.8 s |

The barrier arm measured three statements in three messages; what shipped sends them in one, re-checked the same day: 0/100 under sixteen loops. The 32/128 MB transactions took 4.5-5.4 s and 19.8-22.3 s to write, against 0.23 s and ~1 s in wa-sqlite's runner — RSTEST-OTR again.

## 365-WORST — reading the write-ahead to its end while a large write is open, 2026-09-28, Chromium, this container

wa-sqlite's own runner (web-test-runner, Chromium 151), the fork, master against the unconditional first revision of #365, asyncify and jspi, three rounds alternating the order. Pages of 4 KiB, default cache, so a transaction spills into the WAL past ~2 MiB. A: a transaction open and idle in another worker, 30 `SELECT count(*)` read transactions, median per read — 0 MB ~0 ms both; 8 MB 12-13 ms against ~0; 32 MB 60-62 ms; 128 MB 252-265 ms (max 377). Builds within a few ms of each other; the `sync` build and the headless shell gave 60 ms at 32 MB too. B: a 128 MB transaction committed while another worker reads in a loop — writer ~1.0 s alone and ~1.05 s with the reader on either version; the reader completes ~51 000 reads on master and 130-240 with the change, some near 290 ms. So ~2 ms per MB open, paid by every read, since the median sits next to the maximum.

## BARRIER-DATA — data staleness without the barrier, 2026-09-25, this container

A throwaway data probe: seven scenarios (INSERT, UPDATE,
DELETE without growth; DELETE + VACUUM; bulk INSERT; DROP + CREATE + INSERT read with other SQL
text; a readOnly-transaction read), each in one client (forced writer off index 0, two concurrent
observations so one lands on the primed non-writer) and in two clients. Two worktrees, barrier
statement removed in one, every declared pair × {chromium, firefox}, two passes: 88 cells × 14
tests per arm. **Positive control first:** with the barrier removed AND column names read before
the first step, the DDL scenario goes red in both shapes, so the probe sees staleness when it exists.

| arm | stale values | `disk I/O error` |
| --- | ---: | ---: |
| barrier removed | **3** / 1232 | 4 |
| barrier kept | **0** / 1232 | 13 |

The three stale reads were one observation of the two returning the value from before the write
(`[1, 2]` for `[2, 2]`, `[23, 3]` for `[23, 23]`), on Chromium, first pass, INSERT or UPDATE, one
and two clients; two of them resolved to `IDBBatchAtomicVFS/jspi`. The machine was loaded by
other test runs at the time. **Not reproducible on demand:** a looped probe on that pair — INSERT,
UPDATE, DELETE × one and two clients × 40 — gave **0 / 240 in both arms idle and 0 / 240 in both
arms under sixteen busy loops**. 3 against 0 out of 1232 is not significant on its own (Fisher
p ≈ 0.12): suggestive that the barrier guards something rare, not a proof.

**Reproduced under load, 2026-09-27** (`main` on pin `5e98ac7` with #363, a worktree): the same probe on every pair × {chromium, firefox}, one pass per arm, under sixteen busy loops. **Barrier removed: 37 of 616 tests stale, in 16 of 44 cells, all on Chromium. Barrier kept, same load, same cells: 0 of 616.** Every scenario shows it, in one and in two clients, `bulk INSERT, file grows` included — the growth that the barrier's spec said heals a connection does not. Values are whole pre-write states (`[1, 1]` for `[2, 2]`, `[2, 2]` for `[1, 1]` after a DELETE, `[23, 3]`). A second-pass cell interrupted by the stop was stale too. No `disk I/O error` in either arm (#363). **So the barrier does guard data freshness, and load is what exposes its absence; unloaded, the same probe had given 3 in 1232.** **Cause found the same day.** Pinned per pair, one client, INSERT without growth, barrier removed, sixteen busy loops: **only `OPFSWriteAheadVFS/sync` goes stale** (3/30); `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `IDBBatchAtomicVFS` 0/30. The sweep's other stale cells were `needs` fallbacks: on Chromium `two-workers` resolves to `OPFSWriteAheadVFS/sync` for every target that cannot pool (CoopSync, AHP, IDBMirror, Memory), and `shared-second-client` too for AHP and Memory — except `IDBMirrorVFS`'s own two-client staleness, the documented exception (`mem:vfs`). Firefox is clean because `OPFSWriteAheadVFS` has one connection there. **Mechanism, read in `WriteAhead.js` and then measured:** a read transaction calls `isolateForRead()`, which freezes the connection's view as the `BroadcastChannel` `tx` messages have left it — "not guaranteed to be completely up to date" — while a write calls `isolateForWrite()`, which reads the write-ahead to current. A read issued before the reader's worker has processed the writer's `tx` message sees the state before it; load delays that processing. **A/B, 100 iterations each, same load:** as shipped **28/100** stale; `isolateForRead()` doing `#advanceTxId({ readToCurrent: true })` **0/100**; `WriteAhead.js` + `OPFSWriteAheadVFS.js` from before #355 (`07ad48c`, our pre-2026-09-21 pin) **9/100** — so the design predates our pins. **That 9 vs 28 was one run each, not interleaved, and it overstated the change. Re-measured as an interleaved bisect of `WriteAhead.js` alone** (`OPFSWriteAheadVFS.js` is identical across all four), three rounds in rotated order, 100 iterations per arm per round, same load: **A** before #355 (`07ad48c`) **45/300 = 15.0 %**; **B** with #355 (`afaf3cc7`) **84/300 = 28.0 %**; **C** B + `5b498e5`, upstream master **66/300 = 22.0 %**; **D** C + our #361 as carried **68/300 = 22.7 %**. #355 about doubles it (≈3.9 σ); `5b498e5` lowers it somewhat (≈1.7 σ, not significant); #361 is neutral. Round-to-round spread is ±7 points on one arm, which is why the first pair misled. How #355 moves the timing was not traced: it reorders when the connection opens its `BroadcastChannel` against the WAL load and where the file swap happens, none of it on the read-isolation path itself. The barrier hides it by timing only: one more round trip lets the message land.

**The race itself, traced on version A** (the writer's broadcast, the reader's `tx` arrival and `isolateForRead()`, the worker's `query` arrival, all posted with cross-context timestamps). Stale iteration, ms from the write: writer `tx-broadcast` 10.70 → page write resolved and reads issued 11.30 → reader `query` 11.80 → reader `isolate-read` with `viewTxId` 2 at 11.90 → reader `tx-arrived` txId 3 at 12.20 → read resolves `n = 1`. Fine iteration: broadcast 6.60, `tx-arrived` 7.60, reads issued 8.50, `isolate-read` `viewTxId` 3. **The `tx` message (writer → reader over `BroadcastChannel`) and the read (writer `done` → page → reader `query` over `postMessage`) travel two channels with no ordering between them**; when the second wins, the read freezes a view one transaction behind, and SQLite cannot notice because the VFS serves page 1, change counter included, from that same view.

Every `disk I/O error` is the same test — one client, DELETE + VACUUM, two workers — on Firefox
only, in both arms, so independent of the barrier (`mem:follow-ups`).

## AUTOCHECKPOINT-LATENCY — why `OPFSWriteAheadVFS` cuts late, 2026-09-22, Chromium, this container

CUT-RATIO below left one question open: that pair cuts an abandoned write at 0.67 of its natural
length where every other is under 0.16. **Cause found, by pragma rather than by reading.**

`WriteAhead.js` defaults to `autoCheckpoint: 1` — a checkpoint copying the write-ahead files into
the main database **after every transaction**, fired from `commit()`. No other VFS here has that
stage. `OPFSWriteAheadVFS.jFileControl` exposes it: `PRAGMA wal_autocheckpoint=N` writes
`file.writeAhead.options.autoCheckpoint` and then returns `SQLITE_NOTFOUND`, so SQLite also sees a
pragma that means nothing to a connection outside its own WAL mode.

`OPFSWriteAheadVFS/async`, Chromium, `poolSize` 1, three runs of each arm in one probe:

| | `natural` | `cut` | ratio |
| --- | ---: | ---: | ---: |
| default (`autoCheckpoint: 1`) | 5316 / 5345 / 5372 | 3589 / 3576 / 3526 | 0.675 / 0.669 / 0.656 |
| `wal_autocheckpoint=0` | 5347 / 5464 / 5414 | **160 / 160 / 172** | **0.030 / 0.029 / 0.032** |

**`natural` does not move, and that is the finding.** The checkpoint does not slow the write it
follows — it runs AFTER the commit and occupies the worker, so the interrupt aimed at the NEXT
statement waits for it. Disabling it puts this pair at 0.030, exactly where every other VFS sits.

**What it means for a consumer:** on `OPFSWriteAheadVFS` — a recommended VFS — aborting a statement
gives back about a third of its time, against 97 % elsewhere, and the cost is work the VFS does in
the background rather than anything the caller did. Not a defect of this library, and not fixed
here: `autoCheckpoint: 1` is upstream's default and turning it off unbounds the write-ahead files.
`mem:follow-ups` carries what would have to be decided.

## AUTOCHECKPOINT-THRESHOLD — the threshold works, at values nobody can ship, 2026-09-22, Chromium

`WriteAhead.js` was patched in `node_modules` to do what its option name promises — `this.getWriteAheadSize() >= this.options.autoCheckpoint` instead of `> 0` — and swept by `PRAGMA wal_autocheckpoint`. Same probe shape as CUT-RATIO's T4, `OPFSWriteAheadVFS/async`, Chromium, `poolSize` 1, three runs per arm, all arms in ONE browser process so they are directly comparable.

| threshold (pages) | ratio |
| --- | ---: |
| 1 (= today's behaviour) | .677 / .645 / .669 |
| 250 | .656 / .652 / .638 |
| 1000 (SQLite's own value) | .683 / .667 / .658 |
| 5000 | .660 / .664 / .650 |
| **20 000** | **.029 / .030 / .030** |
| 100 000 | .030 / .031 / .029 |
| 0 (disabled) | .030 / .030 / .030 |

**It is a step, not a curve** — either the checkpoint fires inside the measured window or it does not, and there is no middle to tune. `natural` stayed at 5300-5500 in every arm, so nothing else moved.

**The knee belongs to the workload, not the VFS.** It sits just above the pages the preceding transaction left un-checkpointed — here between 5000 and 20 000 for a 3 M-row insert, i.e. 20-80 MB of write-ahead. A larger transaction moves it up. **For any threshold T, a transaction writing more than T pages puts a checkpoint back on the critical path**, so no value is safe for every workload. A threshold still helps the FREQUENCY of checkpoints on small-transaction workloads — the common case — but it is not the abort-latency fix, and both 250 and SQLite's 1000 sit on the wrong side of the step.

## HANDLE-MODE — `readwrite-unsafe` is NOT why Chromium pays, 2026-09-22

The obvious suspect for the Chromium/Firefox gap, and the user's first guess: this VFS takes `mode: 'readwrite-unsafe'` (`OPFSWriteAheadVFS.js:923`) where the engine offers it, which is Chromium only; Firefox gets an exclusive handle. Forcing `mode: 'readwrite'` at that one site, everything else identical including `poolSize: 1`:

| arm | `natural` | `cut` | ratio |
| --- | ---: | ---: | ---: |
| `readwrite-unsafe` (as shipped) | 5337 / 5434 / 5435 | 3598 / 3582 / 3533 | .674 / .659 / .650 |
| `readwrite` (exclusive) | 5321 / 6464 / 5606 | 3943 / 4343 / 3529 | .741 / .672 / .630 |

**Refuted** — identical, marginally worse if anything. The handle mode is not the cause.

## PAGE-SIZE — the cause is per-call I/O overhead, and Chromium pays it, 2026-09-22

Same probe, `page_size` 4096 (default) against 32768, on both engines.

| engine | `page_size` | `natural` | `cut` | ratio |
| --- | --- | ---: | ---: | ---: |
| Chromium | 4 KiB | 5267 / 5389 / 5314 | 3493 / 3544 / 3521 | .663 / .658 / .663 |
| Chromium | 32 KiB | 1638 / 1639 / 1629 | 441 / 472 / 463 | .269 / .288 / .284 |
| Firefox | 4 KiB | 7904 / 7853 / 7832 | 1127 / 1181 / 1138 | .143 / .150 / .145 |
| Firefox | 32 KiB | 6684 / 6637 / 6663 | **160 / 165 / 156** | **.024 / .025 / .023** |

Identical bytes in every arm; only the number of I/O calls changes, by 8x.

**The asymmetry names the cause.** Eight times fewer pages cuts the whole insert by **3.25x on Chromium** (5320 -> 1635) and by **1.18x on Firefox** (7860 -> 6660). Firefox's bulk insert is dominated by SQLite's own work; Chromium's was dominated by `FileSystemSyncAccessHandle` per-call overhead. The tell: at 32 KiB Chromium is 4x faster than Firefox on the same insert, where at 4 KiB it was only 1.5x faster — **the fastest engine has the slowest I/O calls**.

**Why the checkpoint is where it shows.** `checkpoint()` does one `#fetchPage` read plus one `#dbHandle.write` **per page** (`WriteAhead.js:454-458`), and only page 1 is cached, so it re-reads everything it wrote. It is the purest per-call workload in the VFS, which is why it costs ~3365 ms on Chromium against ~995 ms on Firefox at 4 KiB despite Chromium being faster everywhere else. At 32 KiB on Firefox `cut` reaches 160 ms — the floor every other VFS sits at.

**What it points at:** coalescing contiguous pages into single reads and writes inside `checkpoint()`. Local, no durability or behaviour change. `page_size` is a lever with no upstream dependency at all, but bulk insert is the friendliest case for large pages — a scattered-update workload has NOT been measured and must be before this becomes advice.

## CHECKPOINT-COALESCE — the fix, measured: 0.66 to 0.026 with nothing else changed, 2026-09-22, Chromium

Following PAGE-SIZE: if the cost is call count, coalesce the calls. `checkpoint()` was rewritten in `node_modules` to collect the pages first and then issue contiguous runs as single calls, in two halves.

| variant | `cut` (ms) | ratio |
| --- | ---: | ---: |
| upstream, as shipped | 3493 / 3544 / 3521 | .66 |
| coalesced **writes** only | 1436 / 1426 / 1415 | .26 |
| coalesced **reads + writes** | **165 / 152 / 152** | **.026** |

**0.026 is the floor** — where every other VFS sits, and exactly the disabled-checkpoint arm (0.030). `page_size`, `autoCheckpoint`, `synchronous` and every default untouched.

**Write half:** build a `Map` of db offset -> entry (newest transaction wins, as before), sort by offset, and write each contiguous run as one call with a 4 MiB cap. 2.5x on its own. **Read half:** frames are fixed stride (`FRAME_HEADER_SIZE + pageSize`), so entries grouped by handle (`waSalt1 & 1`) and sorted by `waOffset` form runs that are one read, sliced with `subarray` — no copy. Only strictly consecutive frames of equal page size join a run; anything else falls back to `#fetchPage`. The read half is what reaches the floor, which fits: it was one read per page against one write per run.

**Correctness:** the full cell twice, write-half then both halves, identical to the unpatched baseline — chromium 351/0/4, firefox 355/0/1, isolated 7/0/0, no failures, no `Short WAL read`, no `Checkpoint write failed`.

**Submitted as rhashimoto/wa-sqlite#361 on 2026-09-23 and carried in `patches/` the same day.** Report: `docs/upstream/2026-09-23-wa-sqlite-361-writeahead-checkpoint-coalesce.md`.

## CHECKPOINT-DIRECT — the same fix on the quantity a maintainer can rerun, 2026-09-23

**Why this entry exists, and it is the lesson as much as the measurement:** every figure in CHECKPOINT-COALESCE above is a `cut / natural` ratio taken through OUR harness — rstest, our pool, our abort machinery. That metric cannot be *built* in wa-sqlite: no interrupt, no pool, no abortable statement in its `test/`. A PR carrying only those numbers asks a maintainer to weigh evidence they cannot check.

The quantity underneath needs none of it. `PRAGMA wal_autocheckpoint=0`, bulk insert, then time `PRAGMA wal_checkpoint` on its own — the function the patch changes, called directly. It runs on upstream's own demo page (`demo/?build=default&config=OPFSWriteAheadVFS&reset=true`, two Executes), with **no new file and no build**: `WriteAhead.js` is served as a module and `dist/` is committed, so the two arms are one `git switch` apart.

3 M rows leave a **66 840 704 byte** write-ahead and a **66 314 240 byte** database — 16 190 pages of 4 KiB, read out of OPFS rather than estimated. The disarming is verified the same way: the database is 0 bytes until the checkpoint runs.

| | `PRAGMA wal_checkpoint` (ms) | insert, control (ms) |
| --- | ---: | ---: |
| Chromium 151, `master` | 7172 / 7285 / 7313 | 10907 / 10328 / 10273 |
| Chromium 151, #361 | **197 / 170 / 158** | 11035 / 10329 / 9924 |
| Firefox 153, `master` | 2384 / 2432 | 10058 / 10188 |
| Firefox 153, #361 | **58 / 49** | 9986 / 10049 |

**About 40× on both engines**, the insert unmoved — it runs with the automatic checkpoint disarmed, so the patch cannot reach it.

**Two of this file's own claims are corrected by it.** PAGE-SIZE's asymmetry is about the *insert*, where Firefox is bound by SQLite's own work; on the checkpoint alone both engines gain the same factor, so **"Chromium pays the per-call overhead" is not true of the checkpoint** — the call count dominates everywhere and Chromium merely pays ~3× more per call. And the **~3365 ms PAGE-SIZE attributes to the checkpoint was DERIVED**, a subtraction of two `cut` values, never measured; the direct figures are above, on a different workload shape, and the two are not comparable. What survives from PAGE-SIZE is the mechanism, not that number.

The upstream suite on Chromium, `master` and branch: 14 files, 2899 passing, 0 failing on both.

**Careful with truncated logs.** A first reading of this gave 157/156/161 and "22x". That came from a pre-push hook run of the whole suite, whose tail belonged to `OPFSAdaptiveVFS` — a VFS with no checkpoint, sitting at the floor for free. The number was real and measured the wrong target.


## CHECKPOINT-PLAN — #361 as reviewed: time kept, memory not what the bound says, 2026-09-26

rhashimoto stopped #361 on memory: the first version read the whole checkpoint before writing. Rewritten on his design — a plan of reads and writes, pure planners `coalesceWrites` / `coalesceReads`, `checkpointBufferSize` 4 MiB — and measured on CHECKPOINT-DIRECT's recipe, arms interleaved, `integrity_check` after reload on every run. **Tables and method live in the report** (`docs/upstream/2026-09-23-wa-sqlite-361-…`, "Review").

- **Time, medians:** Chromium 7373 → 196 ms (38×), Firefox 2512 → 77 ms (33×); unbounded first version 40×. Writes coalesced alone: 2.6× / 3.8× — the reads carry the gain. The plan with no planner costs nothing. 1 MiB still ~30×.
- **Memory, `RssAnon` rise over the browser tree:** Chromium 113 (`master`) / 194 (first version) / 146 (plan) MiB, Firefox 30 / 128 / 79. **The peak follows what the synchronous loop allocates, not what it holds** — `master` holds one page yet allocates 66 MB; the plan allocates ~2× the checkpoint. The live-set bound is real, the process does not see it (`mem:lessons`).
## CUT-RATIO — how late an abandoned write is cut, per pair, re-measured 2026-09-25, this container

`tx-savepoint` T3/T4 assert that an abandoned write ends before `natural * f`. **`f` is 0.6 since
2026-09-25** (user's value), after `natural / 2` until 2026-09-15, 0.8, then 0.9 from 2026-09-22 —
0.9 was forced by `OPFSWriteAheadVFS` on Chromium cutting at 0.63-0.81 (0.807 on CI), a cost the
checkpoint coalescing of #361 removed (CHECKPOINT-COALESCE above).

Method: a throwaway probe copying T3 and T4
exactly — fresh `poolSize: 1` client, `natural` uncut, `DELETE`, then the abandoned write — three
runs of each, on every declared pair × {chromium, firefox}, idle machine. The values travel through
a deliberately failing assertion (rstest forwards no console output). `AccessHandlePoolVFS` needs
**one measurement per test** (`cut-ratio-probe-split.test.ts`): its fixed pool of six OPFS files
is given back only by the per-test cleanup, so six 3 M-row databases in one test fail with
`unable to open database file` — a probe artefact, not a product failure. The isolated config is
out of scope: it includes only `tests/browser/isolated/**`, so T3/T4 never run there.

**T3 (abort by signal) is at the floor everywhere: ≤ 0.04.** T4 (the transaction's own timeout)
carries the rollback and spreads further:

| engine | pairs | T4 ratio |
| --- | --- | ---: |
| chromium | **IDBMirrorVFS/jspi** | **0.316 / 0.356 / 0.385** |
| chromium | IDBMirrorVFS/async | 0.185 – 0.219 |
| chromium | MemoryVFS/*, MemoryAsyncVFS/* | 0.134 – 0.168 |
| chromium | IDBBatchAtomicVFS/* | 0.094 – 0.129 |
| chromium | OPFSAnyContextVFS/* | 0.058 – 0.070 |
| chromium | OPFSAdaptiveVFS/*, OPFSCoopSyncVFS/* | 0.045 – 0.050 |
| chromium | OPFSWriteAheadVFS/* (was 0.63-0.81) | 0.025 – 0.030 |
| chromium | AccessHandlePoolVFS/* | 0.015 – 0.016 |
| firefox | every pair | 0.016 – 0.030 |

**`IDBMirrorVFS/jspi` on Chromium is now the latest cut**, and the only pair above 0.22. Its
2026-09-22 figure on `async` was 0.149 against 0.185-0.219 here; T3 on the same pair is 0.015,
so the extra time is in what T4 does after the cut, not in the cut itself. Not chased.

**Variance is LOAD** (established 2026-09-22 on `OPFSWriteAheadVFS`: 0.631 and 0.719 minutes
apart on the same pin, 0.807 on CI). 0.6 sits ~1.55× above the local maximum.

## WAL-COMPAT — a WriteAhead database crosses the 2026-09-21 repin, both ways, 2026-09-21, this container

wa-sqlite #355 adds a file-end flag to the WAL commit frame header, and a comment claims the end
frame is still written and read "for readers that do not understand the commit [flag]". Measured
instead of trusted, because rc.4 is published under `latest` and `OPFSWriteAheadVFS` is recommended,
so consumer databases written by the OLD pin exist. The probe:
two detached worktrees of wa-sqlite — `07ad48c` and `93b9230` —
served from ONE origin, a module worker per step, the `sync` build.

| writer → reader | result |
| --- | --- |
| old → new | rows read back |
| new → old | rows read back |
| old → old, new → new (controls) | rows read back |

**The premise is proved, not assumed, and that arm is the reason the table means anything.** After a
write the main database file is **0 bytes** and the write-ahead file holds **16 608**; emptying the
two `-wa` files WITHOUT deleting them (truncate to 0, so what is tested is their content and not the
VFS's need for the files to exist) makes the same build fail with `no such table: t`. So the rows
genuinely travelled in the write-ahead files, and a cross-version read is a statement about the
frame format. Had they survived, every row of the table above would have been vacuous and the probe
exits non-zero saying so.

Incidental, unexplained and harmless: the old build writes its frames to `-wa1`, the new one to
`-wa0`. Both readers find the active file either way.

## BEGIN-DEFERRED — `OPFSWriteAheadVFS` refuses a deferred write transaction, 2026-09-15, both engines

**Method.** Four throwaway probes,
fresh database per case.

- A transaction whose first statement READS, or writes nothing (`DROP TABLE IF EXISTS <missing>`), and
  then writes: `STATEMENT_FAILED`, extended code **778** (`IOERR_WRITE`) — **3850** (`IOERR_LOCK`) on an
  empty file — and **every later statement on that client fails too**, reads included.
- A single-statement transaction (insert, create, drop, rename, create index, select) passes on a fresh
  database, on `sync`, `async` and `jspi`, both engines.
- A raw `BEGIN` through `write()` reproduces it; `BEGIN IMMEDIATE` does not. `OPFSAdaptiveVFS` passes
  every shape.
- **Cause, read in the source** (`node_modules/wa-sqlite/src/examples/OPFSWriteAheadVFS.js:453-457`):
  `jLock` throws `Write transaction cannot use BEGIN DEFERRED` when SQLite asks RESERVED without the
  write hint, which SQLite only sends for `BEGIN IMMEDIATE`/`EXCLUSIVE` or an autocommit write.
  **Not established:** why the connection stays broken afterwards.
- `output()` hit it through its swap transaction's `DROP TABLE IF EXISTS <target>`, which writes nothing
  when the target does not exist yet: 10 tests of `output.test.ts` plus one of `tx-write.test.ts`.
