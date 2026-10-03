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

## The maintainer's question, 2026-10-01

rhashimoto quoted the description's "the truncation at the end of a `VACUUM` comes after the last `xSync`" and answered that this should not happen. He then reproduced it with SQLite's own CLI and VFS tracing, and asked on the [SQLite forum](https://sqlite.org/forum/forumpost/9b3877d98959eabbaa9884b51dae697acd3dae21ca3ca2e6f3cc5e8d7e669e84) whether a crash between the journal's deletion and the truncation is repaired.

**It is deliberate, and sourced at the version wa-sqlite builds.** Its `Makefile` builds SQLite 3.53.0. In that version's `src/pager.c`, `pager_end_transaction()` shrinks the file in rollback-journal mode after the journal is finalized, while EXCLUSIVE is still held, with no sync after it; its own comment says so (L2145-2152). Growing happens in `sqlite3PagerCommitPhaseOne()`, before the sync. On the forum, Nuno Cruces answered that the mismatch is irrelevant — SQLite ignores data past the database's size — and that the truncation happens under the exclusive lock.

**What that leaves of the case, and the stronger one found by checking.** On Chromium a reader that sees the old size loses nothing, since the excess is ignored; on Firefox the reader's `File` dies with `AbortError`, which is `SQLITE_IOERR_READ`. But the VFS cannot count on an `xSync` after the last change at all: with `PRAGMA synchronous=OFF`, `sqlite3PagerSetFlags()` sets `noSync` and SQLite never calls `xSync`. A two-context probe in wa-sqlite's own runner — A sets `synchronous`, creates a table, inserts 3 rows and stays open, B counts them — gives on upstream master **0 rows with `OFF`**, on asyncify and JSPI, twice, and 3 with `NORMAL` and `FULL`; with the PR, 3 in every case. That is committed rows invisible to another context, unrelated to any truncation.

**Answered** on 2026-10-01 with those sources and that probe, offering the test to the PR. Upstream master was merged into the branch the same day (`87f687b8`), so its test runs on JSPI too: red on master's VFS on both builds, full suite 6031 passing. The description lost its sentence about JSPI being skipped, and its figures were remeasured. The patch did not change: the merge brought nothing to `OPFSAnyContextVFS.js`.

## Second exchange, 2026-10-01

rhashimoto agreed that the truncation after the last sync is deliberate — "a response on the forum by someone knowledgeable concurs" — which is the case the PR handles. He declined the `synchronous=OFF` test: `OFF` is only for write performance, this is not the VFS for that, and with the calls made in unlock anyway it would not get faster. No review decision came with it; the PR stays open.

**Answered** the same day, in one paragraph: the VFS is not the one for write speed, but it is the only OPFS VFS that serves concurrent reads without `readwrite-unsafe` (the bench's `reads-during-long-query`, Firefox 154 and Safari 27, `mem:measurements`), so an application can pick it for that and still set `OFF` for speed — and on master that hides its commits from other contexts, so a test would guard correctness rather than performance; left out unless he wants it. A sentence the user proposed — that no two VFS store files alike, so one cannot write with one and read with another — was dropped after checking: `OPFSAdaptiveVFS` and `OPFSAnyContextVFS` keep a database as the same plain OPFS file, and one read what the other wrote (CROSS-VFS, 2026-09-02). Whether they can share a database at the same time was not measured.

## What stays ours

The same hunk is carried in [`patches/`](../../patches) until wa-sqlite ships it, and guarded here by `tests/browser/vacuum.test.ts`: the footprint of the database's files in OPFS the moment the `VACUUM` resolves — 2 232 320 bytes without the hunk, on Chromium and Firefox alike. That test needs a pair whose database is written in place, a need (`in-place-file`) added for it: `OPFSWriteAheadVFS` keeps its write-ahead files at their size by design, so a footprint says nothing there.

## Review, 2026-10-02: changes requested

rhashimoto recognised the problem from `IDBMirrorVFS`, which already handles it ([L588-612](https://github.com/rhashimoto/wa-sqlite/blob/7a4b4241ba7c61ee19121aacd6c93892234ce1a1/src/examples/IDBMirrorVFS.js#L588-L612)), and asked for the same design instead of `jUnlock`:

- a `File` flag set on `SQLITE_FCNTL_OVERWRITE`;
- close the writable on `SQLITE_FCNTL_SYNC` unless the flag is set, and on `SQLITE_FCNTL_COMMIT_PHASETWO`, which comes after the `VACUUM` truncation;
- `jSync` keeps closing for files other than the main database, which get no `SQLITE_FCNTL_SYNC`.

His reason against `jUnlock`: with `PRAGMA locking_mode=EXCLUSIVE` the database is not unlocked when a transaction ends, so durability suffers. In his words, locks must not be used to infer transaction boundaries. He also listed two known costs, each with a workaround: `synchronous=FULL` syncs the journal twice, and `auto_vacuum=FULL` writes a shrinking transaction twice.

## What his design misses, read in SQLite 3.53.0

Every main-database write and truncation in `pager.c`, `wal.c` and `backup.c` was followed to the unlock, looking for one of `SQLITE_FCNTL_SYNC`, `SQLITE_FCNTL_COMMIT_PHASETWO` or `xSync` in between.

- **Covered on every normal path.** A commit always reaches `sqlite3PagerSync()`, which sends `SQLITE_FCNTL_SYNC` before testing `noSync` (L6400), so even with `synchronous=OFF`. The commit-time truncation is followed by `PHASETWO` (L2155). A successful rollback playback syncs (L2977). A cache spill or `ROLLBACK TO` ends in one of those. A backup syncs at its end.
- **Not covered: I/O errors.**
  - A failed cache-spill write puts the pager in `PAGER_ERROR` (L4656). `sqlite3PagerRollback()` then returns without playback (L6777), and `pager_unlock()` releases the lock.
  - A failed commit write whose rollback playback also fails skips the playback's sync (L2977) and ends the same way (L6811).
- **Not covered, but no worse with the PR.** A `journal_mode=OFF` rollback after a spill, which SQLite already documents as undefined. And the WAL checkpoint, which never sends `SQLITE_FCNTL_SYNC`; on this VFS, which has no `xShmMap`, WAL only runs under `locking_mode=EXCLUSIVE`.

A writable left open at the unlock is closed later, by the same context's next `jRead`, `jFileSize` or `jClose`, with no lock held. Closing replaces the whole file with that context's copy.

## Reproduced, 2026-10-02

The setup was wa-sqlite's runner, in a throwaway detached worktree of the PR head `87f687b8`, with four variants of the VFS:

- master's;
- the PR's;
- his design, written as a subclass of master's;
- his design plus the PR's `jUnlock` close ("both").

Each context is its own worker. A subclass fails main-database `jWrite`s with `SQLITE_IOERR_WRITE` according to a plan, and logs the writes still unpublished at `jUnlock`. The run used Playwright 1.62.1's Chromium and Firefox, both builds, two passes per engine. Every cell was identical across them.

| scenario | master | PR | his design | both |
|---|---|---|---|---|
| A's commit write fails, then its rollback's; B recovers the hot journal and commits a row; A reads: B's row survives | no | yes | no | **yes** |
| the same with a failed cache spill (`cache_size = 10`) | no | yes | no | **yes** |
| `synchronous=OFF`, A inserts 3 rows and stays open: B sees them | no | yes | yes | **yes** |
| `locking_mode=EXCLUSIVE` + `OFF`, A inserts 3 rows and its worker is terminated unclosed: the rows survive | no | **no** | yes | **yes** |
| the same with `NORMAL` | yes | yes | yes | yes |
| `VACUUM` after deleting half the rows: writables opened on the main database | 2 | 2 | 2 | 2 |

- **His `EXCLUSIVE` argument holds.** The PR alone loses those commits.
- **The error paths lose another context's commit on master and on his design.** No original row came back changed and `integrity_check` stayed ok: what was observed is a lost commit, not a corrupted file.
- **The single `VACUUM` copy his design promises does not happen here.** `pager_truncate()` calls `xFileSize` just before truncating (L2669), and `jFileSize` closes the writable. Getting it would take a `jFileSize` that answers without closing.
- **His summary clears the flag on `SQLITE_FCNTL_SYNC`.** The `xSync` that follows would then close the writable anyway. `IDBMirrorVFS` clears it on `PHASETWO`, and so does the tested variant.

Details in `mem:measurements` (363-ERROR-PATH).

## The same question on `IDBMirrorVFS`, 2026-10-02

His design comes from `IDBMirrorVFS`, so the same error-path question was asked of it. The mechanism of this PR does not carry over:

- its main-database writes go to an in-memory `txActive` and cannot fail in practice;
- other contexts only ever see committed transactions, page by page, so no late close can overwrite them.

Its publication point can fail, though: the IndexedDB transaction in `#commitTx`, on a quota error for instance. Reading the code:

- it advances the context's view before that transaction completes;
- it awaits the transaction only with `synchronous=full`;
- on failure it neither drops `txActive` nor rolls the view back.

**Measured.** Same runner and worktree. The worker patches `IDBTransaction.prototype.commit` to `abort()` the next read-write transaction. Both builds, both engines, two passes, every cell identical:

- **With `synchronous=full`**, the default: the failed insert returns `SQLITE_IOERR`. A still sees its rows, and they reach IndexedDB and the other contexts with A's next commit.
- **With `normal`**: the insert returns `ok`, with an unhandled rejection in the worker as the only trace. A fresh context then reads from IndexedDB a database that fails `integrity_check` ("Page 28: never used").

A separate defect, to be offered as its own PR. Details in `mem:measurements` (IDBMIRROR-COMMIT-ABORT).

## Reply posted, 2026-10-02

[Comment 5959910105](https://github.com/rhashimoto/wa-sqlite/pull/363#issuecomment-5959910105). It asks his opinion before reworking anything:

- his design plus the `jUnlock` close as a backstop;
- a test for the error path;
- whether the `jFileSize` change belongs in this PR;
- the `IDBMirrorVFS` finding, offered as a separate PR.

The PR's code is unchanged until he answers.

## His answer, and the rework, 2026-10-02/03

rhashimoto replied on 2026-10-02:

- **The `jUnlock` backstop.** He had considered it but found no path to it; the error path convinced him.
- **The `jFileSize` change.** Not something he wants, since write speed is not a priority for this VFS, but he would review it. The user chose to include it, to close the subject.
- **The overwrite flag.** He agreed to clear it on `COMMIT_PHASETWO`. His worry about a failed `VACUUM` he called weak: the next commit's `PHASETWO` clears it anyway.
- **The `IDBMirrorVFS` PR.** "Yes, please."

**The rework, 2026-10-03.**

- **`0c7ee16d`**, the fix:
  - `jFileControl` closes the stream on `SQLITE_FCNTL_SYNC` unless `SQLITE_FCNTL_OVERWRITE` set the flag, and on `SQLITE_FCNTL_COMMIT_PHASETWO`, which clears it;
  - `jSync` closes the stream unless the flag is set;
  - `jUnlock` keeps its close as the backstop;
  - `File.writableSize` is set when a stream opens and kept by `jWrite` and `jTruncate`, so `jFileSize` answers without closing.
- **`c9208072`**, the test: `test/vfs_publication.js` and its own worker, which subclasses the VFS to fail database writes and counts `createWritable` calls. It holds three cases: a failed cache spill, `EXCLUSIVE` with `OFF` and a terminated worker, and a single-stream `VACUUM` with the file's size checked from the page before A does anything else. `vfs_xUnlock.js` stays as the direct check of the backstop.
- **`345791b3`**, a merge of upstream master `5bde491c`.

**Measured.** The file's 120 tests pass 3 runs of 3 on Chromium and once on Firefox; the whole suite has 6142 passed. Red arms, Chromium, both builds:

| | failed spill | `EXCLUSIVE` | `VACUUM` | `vfs_xUnlock` |
|---|---|---|---|---|
| master's VFS | 200 ≠ 201 | 200 ≠ 201 | 2 streams, 110592 ≠ 61440 bytes | 8192 ≠ 4096 |
| the previous head (`jUnlock` only) | ok | 200 ≠ 201 | 2 streams | ok |
| this head without the backstop | 200 ≠ 201 | ok | ok | 8192 ≠ 4096 |

The first version of the `VACUUM` test passed on master's VFS. Its `PRAGMA page_count` read the database, which closed the stream before the size was checked.

**Published.** The title became "OPFSAnyContextVFS: publish writes where SQLite ends them", and the description was rewritten around the three cases. [Comment 5966506685](https://github.com/rhashimoto/wa-sqlite/pull/363#issuecomment-5966506685) answered, and said the `IDBMirrorVFS` PR comes separately.

## Merged

**Merged on 2026-10-03** by rhashimoto, as `27a6a0b6` on `master`, its `OPFSAnyContextVFS.js` byte for byte the PR's last head `345791b3`. The patch had still carried the previous head's hunk; the repin of 2026-10-03 to `7fcc30df` brought the last head into the pin and dropped the hunk. The `IDBMirrorVFS` PR became [#371](2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md).

