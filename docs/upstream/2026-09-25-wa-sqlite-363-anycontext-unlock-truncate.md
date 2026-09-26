# wa-sqlite #363 — a lock released before the truncation it covers

*2026-09-25 — reproduced on Firefox 153 and Chromium 151, in the container*

[pr363]: https://github.com/rhashimoto/wa-sqlite/pull/363

**Why this is here.** On Firefox, a `VACUUM` on `OPFSAnyContextVFS` made the next read on another worker fail with `disk I/O error` about half the time. The cause is not in this library: `OPFSAnyContextVFS` released its lock while the truncation that ends a `VACUUM` was still held in an open writable stream, invisible to every other context. Proposed upstream as [rhashimoto/wa-sqlite#363][pr363].

## How it was found

Not by looking for it. A probe written to answer another question — whether data can go stale without this library's commit-propagation barrier (BARRIER-DATA in `mem:measurements`) — ran seven write shapes on every pair, and one of them, `DELETE` then `VACUUM` then two concurrent reads in one client with two workers, failed with `disk I/O error` on Firefox in both arms of the comparison, barrier kept or removed. Independent of the barrier, then, and a defect in its own right.

On Firefox, a test that needs two workers resolves to `OPFSAnyContextVFS` whatever the target, which is why the failures looked spread over every VFS at first. A focused probe put it at **8 to 12 failures in 20** on that pair, always the read on the non-writing worker, always extended code **266, `SQLITE_IOERR_READ`** — the VFS's `xRead` itself failing, not a short read. **20 / 20 clean on Chromium**, same pair.

## The mechanism, traced

The VFS was instrumented to post each operation on a `BroadcastChannel` that the test carried into its assertion, since a worker's console never reaches the report — the method `mem:lessons` records from #352. One failing iteration, times in ms from the `DELETE`:

| t | worker | event |
| ---: | --- | --- |
| 116 | writer | last `xSync` of the transaction |
| 119 | writer | `openWritable`, `truncate` to 8192 — **no `xSync` after it** |
| 120 | — | the client's `VACUUM` has resolved; the two reads are issued |
| 120 | reader | `SHARED` lock taken |
| 121 | writer | closes its writable, for its own next `xRead` |
| 122 | reader | `getFile()` returns **2 232 320 bytes** — the file before the truncation |
| 123 | reader | reading that `File` fails with **`AbortError`** → `SQLITE_IOERR_READ` |

Writes and truncations go through a `FileSystemWritableFileStream` that only `xSync` closes, and nothing it holds is visible to another context until it is closed. SQLite calls no `xSync` after the truncation that ends a `VACUUM`, so the lock was released with the shrink unpublished. The reader took the lock, got the old file, and on Firefox that `File` died once the writer's close replaced it. Chromium does not raise there, but the reader still sees the old size — the upstream test below observes exactly that, on Chrome.

## The fix, and the hypothesis test that preceded it

Before any upstream work, the hypothesis was tested in the instrumented copy: a `jUnlock` override that closes a pending writable before calling the lock mixin's. **60 / 60 on Firefox** (`jspi` and `async`) against 8-12 failures in 20 without it, 20 / 20 on Chromium.

The PR is that override: close the writable, then release the lock; a failed close is reported as `SQLITE_IOERR_UNLOCK` and the lock is released either way.

## Reproducible by the maintainer

`test/vfs_xUnlock.js`, wired into `OPFSAnyContextVFS.test.js`, calls the VFS directly in two contexts: A writes 8192 bytes, syncs, truncates to 4096 with no `xSync` after it — the shape SQLite gives the end of a `VACUUM` — and unlocks; B takes `SHARED` and reads the size. On upstream `master`, **`Expected 8192 to equal 4096`**; on the branch it passes. The whole suite on the branch: **14 files, 2911 passing, 0 failing**. The `jspi` describes are skipped locally, `TestContext.supportsJSPI()` building a `WebAssembly.Function` that Chrome 151 no longer has.

## Posted upstream

PR [#363][pr363], opened 2026-09-25 from `lalexdotcom:fix/anycontext-unlock-publishes-truncate`, on `master` at `e98c65de` — our pin at the time (it moved to `5e98ac7` on 2026-09-26, which does not touch `OPFSAnyContextVFS.js`). **One commit, three files, +82 / −0.** Upstream CI on the head commit is green — [run 36159452292](https://github.com/rhashimoto/wa-sqlite/actions/runs/36159452292), `build (20.x)`, the only check.

It does not mention this library, per the standing rule: every figure in it is reproducible with wa-sqlite alone.

## What stays ours

The same hunk is carried in [`patches/`](../../patches) until wa-sqlite ships it, and guarded here by `tests/browser/vacuum.test.ts`: the footprint of the database's files in OPFS the moment the `VACUUM` resolves — 2 232 320 bytes without the hunk, on Chromium and Firefox alike. That test needs a pair whose database is written in place, a need (`in-place-file`) added for it: `OPFSWriteAheadVFS` keeps its write-ahead files at their size by design, so a footprint says nothing there.
