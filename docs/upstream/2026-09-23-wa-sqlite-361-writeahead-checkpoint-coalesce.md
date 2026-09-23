# wa-sqlite #361 — a checkpoint that costs one call per page

*2026-09-23 — measured on Chromium 151 and Firefox 153, in the container*

[pr361]: https://github.com/rhashimoto/wa-sqlite/pull/361

**Why this is here.** `OPFSWriteAheadVFS` is one of the two VFS [browser-sqlite](../../README.md) names in its benchmark page, and it is the one whose abort was weakest: a statement cut short on it gave back a third of its time where every other VFS gave back 97 %. The cause is not in this library. It is in `WriteAhead.checkpoint()`, which moves the write-ahead into the database **one page at a time**, and that work occupies the worker after the commit — so an interrupt aimed at the next statement waits it out. Proposed upstream as [rhashimoto/wa-sqlite#361][pr361].

## The shape of it

`checkpoint()` walks transactions backwards and writes each page as it meets it:

```js
const pageData = pageEntry.pageData ?? this.#fetchPage(pageEntry);
const nWritten = this.#dbHandle.write(pageData, { at: offset });
```

`#writePage` keeps the bytes only for page 1 (`pageData: pageOffset === 0 ? pageData : undefined`), so every other page is re-read from the write-ahead file and then written to the database: **two synchronous access handle calls per page**, each carrying 4 KiB.

The fix collects the pages first and then issues each run of adjacent pages as one call — reads and writes independently, each falling back to the existing path for a run of one. Frames are a fixed stride, so consecutive frames of equal page size are read into one buffer and sliced with `subarray`, without copying.

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

The full upstream suite on Chromium, run on `master` and on the branch: **14 test files, 2899 passing, 0 failing** on both, with no `Short WAL read` and no `Checkpoint write failed` in either. No test accompanies the change, because it pins no behaviour — the same bytes go to the same offsets in the same order. The suite passing unchanged is the argument.

The debug log is unchanged too, which was a late correction: the first version replaced the per-page log line with a per-run one and silently dropped the `txId`. Since `this.log?.()` does not evaluate its arguments when `log` is null, there was no reason to trade it away — each page now carries the transaction it came from, and the message is upstream's, word for word.

## Posted upstream

PR [#361][pr361], opened 2026-09-23 from `lalexdotcom:fix/writeahead-checkpoint-coalesce`, on `master` at `e98c65de` — current at the time of writing, two commits on from our pin, neither touching `checkpoint()`. **One commit, one file, +111 / −14.**

Upstream CI on the head commit is green — [run 35837869075](https://github.com/rhashimoto/wa-sqlite/actions/runs/35837869075), `build (20.x)`, the only check.

Three things the PR says out loud rather than leaving for review to find: it is measured on a bulk insert, the friendliest shape for contiguous runs; the 4 MiB cap bounding the transient buffer is arbitrary; and it cannot be *slower* than the current code by construction — a run of one is the current path plus a comparison — but that last claim is reasoned, not measured.

It does not mention this library, per the standing rule: a stable library is not argued from an unstable one, and every figure in it is reproducible with wa-sqlite alone.

## What stays ours

Two levers this change does not touch, both still open and both recorded in `mem:follow-ups`:

- **`autoCheckpoint` never reads the value it is given.** A separate, cheap correctness point — worth asking for on its own, not folded in here.
- **`page_size`** is ours with no upstream at all. It is not yet a recommendation: bulk insert is the friendliest case for large pages, and a scattered-update workload has not been measured.
