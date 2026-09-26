# wa-sqlite #361 — a checkpoint that costs one call per page

*2026-09-23 — measured on Chromium 151 and Firefox 153, in the container. Review answered 2026-09-26.*

[pr361]: https://github.com/rhashimoto/wa-sqlite/pull/361
[review]: https://github.com/rhashimoto/wa-sqlite/pull/361#pullrequestreview-5297769022
[reply]: https://github.com/rhashimoto/wa-sqlite/pull/361#issuecomment-5848983668

**Why this is here.** `OPFSWriteAheadVFS` is one of the two VFS [browser-sqlite](../../README.md) names in its benchmark page, and it is the one whose abort was weakest: a statement cut short on it gave back a third of its time where every other VFS gave back 97 %. The cause is not in this library. It is in `WriteAhead.checkpoint()`, which moves the write-ahead into the database **one page at a time**, and that work occupies the worker after the commit — so an interrupt aimed at the next statement waits it out. Proposed upstream as [rhashimoto/wa-sqlite#361][pr361].

## The shape of it

`checkpoint()` walks transactions backwards and writes each page as it meets it:

```js
const pageData = pageEntry.pageData ?? this.#fetchPage(pageEntry);
const nWritten = this.#dbHandle.write(pageData, { at: offset });
```

`#writePage` keeps the bytes only for page 1 (`pageData: pageOffset === 0 ? pageData : undefined`), so every other page is re-read from the write-ahead file and then written to the database: **two synchronous access handle calls per page**, each carrying 4 KiB.

The first version collected the pages first and then issued each run of adjacent pages as one call — reads and writes independently, each falling back to the existing path for a run of one. Frames are a fixed stride, so consecutive frames of equal page size were read into one buffer and sliced with `subarray`, without copying. **It held every page of the checkpoint in memory at once**, which the review caught; what the branch and our patch carry now is under [Review](#review-the-whole-checkpoint-in-memory-and-a-plan-instead).

## Three things that had to be refuted first

**A threshold is not the fix.** `#autoCheckpoint()` tests `this.options.autoCheckpoint > 0` and nothing else, so 1, 100 and 1000 all mean "after every transaction" — the option is a boolean wearing a number. Patching it to compare against `getWriteAheadSize()` and sweeping the threshold gives **a step, not a curve**: 1, 250, 1000 and 5000 all sit at 0.65, and 20 000 and 100 000 both sit at 0.030, exactly the disabled arm. The knee sits just above the pages the preceding transaction left un-checkpointed, so it belongs to the workload, not to the VFS: for any threshold T, a transaction writing more than T pages puts a checkpoint back on the critical path. AUTOCHECKPOINT-THRESHOLD in `mem:measurements`.

**`readwrite-unsafe` is not the cause.** The obvious suspect for the Chromium/Firefox gap. Forcing `mode: 'readwrite'` at `OPFSWriteAheadVFS.js:923`, everything else identical: no change, marginally worse if anything. HANDLE-MODE.

**Page size named the real one.** At 32 KiB instead of 4 KiB — eight times fewer pages, identical bytes — the whole bulk insert runs 3.25× faster on Chromium against 1.18× on Firefox. The asymmetry is the tell: Chromium was bound by `FileSystemSyncAccessHandle` per-call overhead, not by bytes. PAGE-SIZE.

## Measured, and reproducible by the maintainer

**This is the part that took the longest, and it is the point of the entry.** Every number the earlier draft carried came from our own harness: an rstest browser probe, our worker pool, our abort machinery. The metric itself — `cut / natural`, how much of a write an abandoned statement gives back — cannot even be *built* in wa-sqlite: there is no interrupt, no pool, no abortable statement in `test/`. A maintainer could not have rerun a single figure.

The quantity underneath needs none of that. Disarm the automatic checkpoint, bulk-insert, then time an explicit `PRAGMA wal_checkpoint` — which is the function the patch changes, called directly. It runs on upstream's own demo page, with **no new file and no build**: `WriteAhead.js` is served as a module and `dist/` is committed, so the two arms are one `git switch` apart.

```sql
PRAGMA wal_autocheckpoint=0;
CREATE TABLE t(a INTEGER, b TEXT);
INSERT INTO t WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<3000000)
  SELECT i, 'row' || i FROM c;
```

then, as a second execute, `PRAGMA wal_checkpoint;` alone.

That the disarming takes effect is not assumed — it is read out of OPFS between the two steps: after the insert the database file is **0 bytes** and the write-ahead holds **66 840 704**; after the checkpoint, the reverse. 16 190 pages of 4 KiB.

| | `PRAGMA wal_checkpoint` (ms) | insert, control (ms) |
| --- | ---: | ---: |
| Chromium, `master` | 7172 / 7285 / 7313 | 10907 / 10328 / 10273 |
| Chromium, `#361` | **197 / 170 / 158** | 11035 / 10329 / 9924 |
| Firefox, `master` | 2384 / 2432 | 10058 / 10188 |
| Firefox, `#361` | **58 / 49** | 9986 / 10049 |

**About 40× on both engines.** The insert is the control: it runs with the automatic checkpoint disarmed, so the patch cannot reach it, and it does not move.

**And the engines agreeing is what corrects our own reading.** PAGE-SIZE's asymmetry was about the *insert*, where Firefox is bound by SQLite's own work. On the checkpoint alone both engines gain the same factor: the call count dominates everywhere, and Chromium merely pays about three times more per call. The draft that said this was a Chromium problem was wrong on that point.

**One more correction, and it belongs on the record.** `mem:measurements` attributed ~3365 ms to the checkpoint on Chromium. That figure was *derived* — a subtraction of two `cut` values — never measured. The direct measurement is above; it is a different workload shape and the two are not comparable. What survives is the mechanism, not that number.

## Correctness

The full upstream suite on Chromium, run on `master` and on the branch: **14 test files, 2899 passing, 0 failing** on both, with no `Short WAL read` and no `Checkpoint write failed` in either. No test accompanied the first version, because it pins no behaviour — the same bytes go to the same offsets in the same order. The suite passing unchanged was the argument. The rewrite after review does bring tests, for the planners it introduces.

The debug log is unchanged too, which was a late correction: the first version replaced the per-page log line with a per-run one and silently dropped the `txId`. Since `this.log?.()` does not evaluate its arguments when `log` is null, there was no reason to trade it away — each page now carries the transaction it came from, and the message is upstream's, word for word. The rewrite gave that up: a plan names pages by WAL offset and knows nothing of transactions, so its log line reports each write — how many pages, at which offset.

## Review: the whole checkpoint in memory, and a plan instead

rhashimoto [reviewed][review] on 2026-09-25: he would merge if everything resolved, and one point stopped him. **The first version held the whole checkpoint in memory.** `#fetchPages` read every page before the first write; `MAX_RUN_SIZE` bounded a single run, not the total. That caps the size of a transaction, and hits far sooner than the other places where the VFS lets state grow. The PR description's "the transient buffer stays bounded" was false of that code — our [reply] says so first.

**His design, taken as given.** A checkpoint becomes a *plan*: `{ pageSize, actions }`, each action a `read` of WAL pages or a `write` of them `at` a database offset, pages named by WAL offset with 2^52 added for the newer WAL file. A *planner* is a pure function from plan to plan — unit-testable, swappable, the identity a valid one. Buffer usage is his definition: the unretired reads plus the next write. He asked to start with writes coalesced over single reads, and "maybe after that" reads coalesced within one write; the fully optimal plan he called a research topic of its own.

**What the branch carries now**, commit `68db49b3`:

- `checkpoint()` builds the base plan — a single-page read and write per page, newest transaction first, a page a newer one wrote skipped — and runs it through `#executeCheckpointPlan`, which reads a whole span of frames in one call and decodes the WAL file from the 2^52 offset.
- The planners are exported pure functions: `coalesceWrites(plan, { bufferSize })` is his first step, `coalesceReads(plan)` his second. Frames in different WAL files are never joined.
- **The one design decision of ours:** `coalesceWrites` caps a run at `bufferSize / (2 * pageSize + FRAME_HEADER_SIZE)` pages, reserving room for the frame headers `coalesceReads` would read if it later joins that run's reads. `coalesceReads` therefore takes no budget and cannot overrun the one reserved.
- `DEFAULT_CHECKPOINT_BUFFER_SIZE`, 4 MiB, as `checkpointBufferSize` in `WriteAheadOptions` — his line comment, word for word.
- `test/WriteAheadCheckpointPlan.test.js` replays his SQL example: `coalesceWrites` at his buffer size produces his first plan exactly, `coalesceReads` his second, reads within a write in WAL order. On randomised plans, each planner writes the same pages as the base plan, and peak usage stays within `bufferSize`. Dropping the header reservation fails that bound — checked by mutation. Full upstream suite on Chromium: green.
- **A new error path, flagged to him:** `checkpoint()` throws `Checkpoint page size mismatch` if a plan's pages differ in size. A plan has one `pageSize`, and the `newPageSize` break should already guarantee it — but it is new throwing code in something his sponsors run in production.

### Time

The recipe above, unchanged: 3 M rows, `PRAGMA wal_checkpoint` timed, defaults untouched. Arms interleaved within each round; every run then reloads the page without `reset` and passes `PRAGMA integrity_check` against the checkpointed file.

| `PRAGMA wal_checkpoint` (ms) | Chromium | Firefox |
| --- | ---: | ---: |
| `master` | 7742 / 7373 / 7331 | 2512 / 2460 / 2516 |
| first version (unbounded) | 187 / 183 / 166 | 62 / 53 / 64 |
| base plan, no planner | 7228 / 7041 / 7219 | 2476 / 2571 / 2399 |
| `coalesceWrites` | 2828 / 2787 / 2824 | 682 / 659 / 657 |
| **`coalesceReads(coalesceWrites(…))`, 4 MiB** | **196 / 191 / 210** | **74 / 77 / 80** |
| same, 1 MiB | 236 / 246 / 243 | 89 / 95 / 83 |

- **The plan costs nothing:** with no planner it runs at `master`'s speed.
- **His first step alone is 2.6× on Chromium and 3.8× on Firefox** — most calls are still one read per page.
- **His second step is 38× and 33×**, against 40× unbounded. Bounding the buffer costs very little, and 1 MiB still gives about 30×.

### Memory — the bound is not what the process sees

`RssAnon` summed over the browser's process tree, sampled every 5 ms: the rise from the median just before the checkpoint to the peak during it. A Playwright harness of ours on the Linux container — a rough measure, and not one a maintainer reruns from the demo page.

| RSS rise during checkpoint (MiB) | Chromium | Firefox |
| --- | ---: | ---: |
| `master` | 113 / 109 / 120 | 30 / 27 / 31 |
| first version (unbounded) | 191 / 194 / 194 | 102 / 128 / 132 |
| `coalesceReads(coalesceWrites(…))`, 4 MiB | 164 / 146 / 140 | 75 / 83 / 79 |
| same, 1 MiB | 123 / 142 / 135 | 74 / 73 / 81 |

**The peak follows what the checkpoint allocates, not what it holds.** The checkpoint is one synchronous loop, and garbage is not reclaimed while it runs. `master` holds one page at a time yet allocates a fresh `Uint8Array` for every page, 66 MB in all; the plan executor allocates a new buffer for every read and every write, roughly twice the checkpoint. A smaller buffer does not change the rise — the volume allocated stays the same.

**So the saving against the first version is about 48 MiB on both engines, and the plan still sits above `master`.** This corrects a figure of ours: the "about 67 MB down to 4 MiB" given before measuring was computed from the live set, never measured — the same class of error as the 3365 ms above.

### Suggested in the reply, not pushed

- **One allocation per checkpoint.** The executor allocates a single `bufferSize` region: reads fill it in sequence, the write takes the rest, and it resets after each write. That is his accounting realised directly, and it holds for both planners because every write retires all the reads before it. Allocation drops from about twice the checkpoint to `bufferSize`, which should put the executor below `master` in memory as well as in time. A planner keeping unretired reads across writes — his tighter example — would need a finer allocator or a fallback. Offered here or as a follow-up, his choice.
- **The default buffer size**: 4 MiB and 1 MiB are within 20 % of each other on this workload.
- **Scattered writes are still unmeasured.**

## Posted upstream

PR [#361][pr361], opened 2026-09-23 from `lalexdotcom:fix/writeahead-checkpoint-coalesce`, on `master` at `e98c65de` — current at the time of writing, two commits on from our pin, neither touching `checkpoint()`. **One commit, one file, +111 / −14.**

Upstream CI on the head commit is green — [run 35837869075](https://github.com/rhashimoto/wa-sqlite/actions/runs/35837869075), `build (20.x)`, the only check.

Three things the PR says out loud rather than leaving for review to find: it is measured on a bulk insert, the friendliest shape for contiguous runs; the 4 MiB cap bounding the transient buffer is arbitrary; and it cannot be *slower* than the current code by construction — a run of one is the current path plus a comparison — but that last claim is reasoned, not measured.

It does not mention this library, per the standing rule: a stable library is not argued from an unstable one, and every figure in it is reproducible with wa-sqlite alone.

**After review, 2026-09-26:** `68db49b3` pushed on top of the first commit, history untouched — against `e98c65de` the branch is now `+153 / −10` in `WriteAhead.js` and `+162` in the new `test/WriteAheadCheckpointPlan.test.js`. The [reply] went up the same day, with the tables above and the suggestions. Upstream CI on it is green — [run 36264556487](https://github.com/rhashimoto/wa-sqlite/actions/runs/36264556487).

**Carried here:** `patches/wa-sqlite@1.1.2.patch` holds `68db49b3`'s `WriteAhead.js` byte for byte, in place of the first version; the test file stays upstream, the patch covering `src/` only.

## What stays ours

What this change leaves open:

- **The single allocation per checkpoint** waits on his answer — in this PR or after it. Until then the patch carries the executor that allocates per call.
- **`autoCheckpoint` never reads the value it is given.** A separate, cheap correctness point — worth asking for on its own, not folded in here. In `mem:follow-ups`.
- **`page_size`** is ours with no upstream at all. It is not yet a recommendation: bulk insert is the friendliest case for large pages, and a scattered-update workload has not been measured. In `mem:follow-ups`.
