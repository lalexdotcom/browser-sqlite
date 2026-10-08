# Measurements — the campaigns behind wa-sqlite PRs

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## 363-ERROR-PATH — a write error leaves `OPFSAnyContextVFS`'s writable open at unlock, 2026-10-02, Playwright's Chromium and Firefox (1.62.1), this container

**Why.** rhashimoto's review of #363 (2026-10-02) asks to close the writable on `SQLITE_FCNTL_SYNC` (skipped after `SQLITE_FCNTL_OVERWRITE`), `SQLITE_FCNTL_COMMIT_PHASETWO` and `jSync`, not in `jUnlock`. Read in SQLite 3.53.0: every normal path ends in one of those, but an I/O error does not. A failed cache spill puts the pager in `ERROR` (`pagerStress` → `pager_error`, pager.c L4656), `sqlite3PagerRollback` then returns at once without playback (L6768), and `pager_unlock` releases the lock; a failed commit write whose rollback playback fails too skips the playback's `sqlite3PagerSync` (L2977) and ends the same way (L6811).

**Method.** wa-sqlite's runner, a throwaway detached worktree of #363's head `87f687b8`, three variants of the VFS: master's (`fa111290`), the PR's, and his design written as a subclass of master's (flag set on `OVERWRITE`, close on `SYNC` unless set, close and clear on `PHASETWO`, `jSync` skipped for an overwritten main db). Each context is its own worker whose VFS subclass fails main-db `jWrite`s with `SQLITE_IOERR_WRITE` on a plan and logs unpublished writes at `jUnlock`. A creates 200 rows of `randomblob(500)`, then fails: **commit** — `UPDATE t SET x = randomblob(500)`, writes 1-3 pass, 4 fails, the rollback's next 2 pass, the rest fail; **spill** — `cache_size = 10`, a 2000-row insert in one transaction, writes 1-5 pass, every later one fails. B then counts, inserts one row and commits; A counts once more; C runs `integrity_check`, counts, and compares the first 8 bytes of every original row with A's before the failure. Both builds, two passes per browser.

| variant | at A's unlock | B after its commit | C: count, B's row | integrity |
|---|---|---|---|---|
| master | 2 (commit) / 5 (spill) writes unpublished, writable open | 201 | **200, lost** | ok |
| his design | the same | 201 | **200, lost** | ok |
| PR (`jUnlock` closes) | published, writable closed | 201 | 201, kept | ok |

Identical on Chromium and Firefox, asyncify and jspi, both passes. A's next read closes its stale writable, which replaces the whole file with A's copy: B's committed transaction is gone. No original row came back changed and `integrity_check` stayed ok, so what was observed is a lost commit, not a corrupted file.

**Same day, a fourth variant — his design plus the PR's `jUnlock` close ("both") — and more scenarios**, same method, both builds, both engines, two passes each, every cell identical across them:

| scenario | master | PR | his design | both |
|---|---|---|---|---|
| write error, commit or spill: B's commit kept | no | yes | no | yes |
| `synchronous=OFF`, 3 rows inserted, A stays open: B counts | 200 | 203 | 203 | 203 |
| `locking_mode=EXCLUSIVE` + `OFF`, 3 rows inserted, A's worker terminated unclosed: B counts | 200 | **200** | 203 | 203 |
| the same with `NORMAL` | 203 | 203 | 203 | 203 |
| `VACUUM` after deleting half the rows: `createWritable` on the main db | 2 | 2 | 2 | 2 |

His `locking_mode=EXCLUSIVE` argument holds: with `OFF` the PR alone loses the commit when the context dies. His `VACUUM` saving does not happen in this VFS: `pager_truncate` calls `xFileSize` before truncating (pager.c L2669), and `jFileSize` closes the writable, so the truncation opens a second one whatever the publication points. Trace on every variant: `OVERWRITE`, journal synced twice (`FULL`), main-db writable created, `SYNC`, `jSync`, `truncate`, a new writable, `PHASETWO`.

## 369-XCLOSE — what releases `OPFSAdaptiveVFS`'s open lock, 2026-10-02, Playwright's Chromium and Firefox (1.62.1), this container

**Why.** rhashimoto on #369 (2026-10-02): SQLite does call `xClose` after a failed `xOpen` — his trace shows `jClose` from `sqlite3_open_v2()` — so the primary defect is `jClose` not releasing `openLockReleaser`. Read: wa-sqlite's `libvfs_xOpen` sets `pMethods` whatever the JS `xOpen` returns (`src/libvfs.c` L122-146), and SQLite's `sqlite3OsClose` calls `xClose` whenever `pMethods` is set (os.c L81), e.g. from `sqlite3PagerOpen`'s failure cleanup (pager.c L5033). Our PR's sentence "SQLite does not call xClose after a failed xOpen" is wrong.

**Method.** wa-sqlite's runner, the #363 throwaway worktree (its `OPFSAdaptiveVFS.js` is upstream master's, identical from `e6e01ae1` to `7a4b4241`). One worker per context with `FileSystemSyncAccessHandle.prototype.mode` deleted (the path without `readwrite-unsafe`), `jOpen`/`jRead`/`jClose` traced, every call bounded at 5 s. Variants: master; the PR (`744f4221`); `closeLock` — master whose `jClose` calls `openLockReleaser`; `closeAll` — `jClose` also releases `handleLockReleaser` and closes the channel. Both builds, both engines, two passes, all cells identical.

| scenario | master | PR | closeLock | closeAll |
|---|---|---|---|---|
| open fails on a held file, the file is released, reopen in the same worker | **hung** | ok | ok | ok |
| open, close, reopen (same worker, other worker); open + `SELECT 1` or a query, close, open in another worker | ok | ok | ok | ok |

- `jClose` is called after the failed open on every variant (trace: `open -> 14`, then `close`).
- Opening and closing with no statement does not keep the lock: `sqlite3_open_v2` reads the header (`read @0`), which releases it.
- A first `jClose` variant that closed the channel without releasing `handleLockReleaser` made the next open in another worker hang after any read. Master's `jClose` leaves the channel open and the handle lock held, and a later request on that channel is what releases the lock.

## IDBMIRROR-COMMIT-ABORT — an IndexedDB commit that aborts inside `IDBMirrorVFS`'s `#commitTx`, 2026-10-02, Playwright's Chromium and Firefox (1.62.1), this container

**Why.** Checking whether 363-ERROR-PATH applies to `IDBMirrorVFS`. Its main-db writes go to an in-memory `txActive` and cannot fail in practice; the publication point that can fail is `#commitTx`, whose IndexedDB transaction may abort (quota). Read: it calls `#acceptTx`/`#setView` before the IndexedDB transaction completes, awaits it only with `synchronous=full`, and on failure neither drops `txActive` nor rolls the view back (`#dropTx` only on `ROLLBACK_ATOMIC_WRITE`).

**Method.** wa-sqlite's runner, the same throwaway worktree (upstream `IDBMirrorVFS.js` unchanged, pin `7a4b4241`), one worker per context, a fresh IndexedDB database per case. The worker patches `IDBTransaction.prototype.commit` so that, once armed, the next `readwrite` transaction calls `abort()` instead. A and B open, A creates 200 rows; A inserts 3 rows with the next commit aborted; A and B count; A inserts 1 row normally; B counts, checks, inserts 1 row; A counts; both close; a fresh C counts and checks. Both builds, both engines, two passes — every cell identical.

| | `synchronous=full` (the default) | `synchronous=normal` |
|---|---|---|
| A's failed insert | `SQLITE_IOERR` | **`ok`** — an unhandled rejection in the worker, nothing else |
| A then counts | 203 — its failed rows | 203 |
| B counts | 200 | 200 |
| after A's next commit, B counts | **204: the 3 rows of the failed insert came back** with it | 200 |
| B's own insert | ok | `SQLITE_BUSY`, once (not chased) |
| fresh C, from IndexedDB | 205, `integrity_check` ok | **200, `integrity_check`: "Page 28: never used"** |

So with `full` a commit SQLite reported as failed becomes durable with the next one; with `normal` the failure is silent and the stored database ends up corrupt.

## IDBMIRROR-ABORT-JOURNAL — an aborted `IDBMirrorVFS` commit, then the next write, a reopen or exclusive mode, 2026-10-03, Playwright 1.62.1 Chromium (and Firefox for P1-P3), this container

**Method.** wa-sqlite's runner on branch `fix/idb-mirror-commit-abort` (upstream `5bde491c` + the poison fix), throwaway probes, one worker per connection, the worker patching `IDBTransaction.prototype.commit` to abort the next read-write transaction (optionally after keeping it alive N ms). VFS calls traced by wrapping the instance's `j*` methods. Arms: the pushed fix ("poison": `jRead`/`jWrite`/`jTruncate`/`jFileSize` throw after the abort) and a prototype that only blocks writes and reloads blocks + `viewTx` from IndexedDB at the next SHARED from `NONE`.

| case | pushed fix | reload prototype |
|---|---|---|
| `full`, keep using A | A dead; store ok | A recovers (next insert ok); store ok, 12/12 both engines |
| `normal`, keep using A | A dead after one failed write; store ok | next write `IOERR` once, then ok — **store corrupt** ("Page 28: never used"), 12/12 |
| `normal`, read transaction in flight when the abort lands | — | reads consistent (203, 203), reload after `COMMIT` (200), store ok, 12/12 |
| `normal`, A reopens in the same VFS | **store corrupt**, 4/4 Chromium | (same journal path) |
| `full`, A reopens in the same VFS | ok, 4/4 | ok, 4/4 |
| `locking_mode=EXCLUSIVE`, `full` | every statement `IOERR`; store ok | same |
| `locking_mode=EXCLUSIVE`, `normal` | **next commit returns ok and is stored on top of the lost one** (tx 4 stored, tx 3 absent); `integrity_check` ok only because it touched page 28, beyond the header's 27 | same |

**Cause, traced.** The next write's batch fails (`jWrite` → 778), `ROLLBACK_ATOMIC_WRITE`, then SQLite opens `<db>-journal`, writes it and fails on the database; the journal stays in the VFS. The next SHARED (reload) or open (same VFS) sees it hot and replays pages 1 and 28 from the lost view, then `SYNC` stores them. `pager.c` 3.53.0, `sqlite3PagerCommitPhaseOne`: an `IOERR`-class error other than `IOERR_NOMEM` from the batch triggers `sqlite3JournalCreate` and a non-batch retry; any other error closes the journal. `pager_unlock`: outside exclusive mode an error releases to `NO_LOCK` and resets the cache; in exclusive mode the cache is reset but the VFS sees no unlock.

Side observation: under `normal`, closing right after a commit can throw `InvalidStateError` from `BroadcastChannel.postMessage` in `#commitTx`'s `oncomplete` (channel closed by `jClose`). On master too: IDBMIRROR-CLOSE-BROADCAST.

## IDBMIRROR-ABORT-DESIGNS — five fixes for an aborted `IDBMirrorVFS` commit, measured side by side, 2026-10-03, Playwright 1.62.1 Chromium + Firefox, asyncify + jspi, this container

**Method.** Same harness as IDBMIRROR-ABORT-JOURNAL: one worker per connection, `IDBTransaction.prototype.commit` patched to abort the next read-write transaction (optionally kept alive 300 ms first). Eleven scenarios × `full`/`normal` (one-connection continue with and without `busy_timeout`, a read transaction in flight, reopen in the same VFS, `locking_mode=EXCLUSIVE`, exclusive with commits queued behind a delayed abort, `synchronous=off`, a spilling transaction aborted, a spilling transaction after the abort, exclusive with no abort as control, close right after a commit), 2 runs each: 168 probes per arm. Each probe ends with a fresh connection counting tagged rows and running `integrity_check`. Perf: 300 single-row commits in one `exec`, 9 runs interleaved with master.

**Arms.** M = upstream `5bde491c`. P = the pushed branch (poison `jRead`/`jWrite`/`jTruncate`/`jFileSize` on abort). P′ = poison reads only, writes never fail, refuse in `#commitTx` (checked before and after its `await`), a gate request when a previous commit is pending, journal deleted on `jClose` of an aborted file. E4 = P′'s safety pieces without the read poison, plus reload of blocks + `viewTx` at the next SHARED from `NONE` and in `full`'s abort path (journal deleted on reload), and `SQLITE_BUSY` at RESERVED while aborted. E2 = E4 with `await` of the previous commit instead of the gate; E3 = E4 with the gate on every commit.

| | stores corrupt | `full`: refused rows stored | connection after the abort | exclusive `normal` perf |
|---|---|---|---|---|
| M | 48 / 168 | 48 | keeps going on a lost view | baseline |
| P | 8 (reopen, `normal`) | 0 | dead until reopen | = M |
| P′ | 0 | 0 | dead until reopen; reopen clean | (not timed; same commit path as E4) |
| E2 | 0 | 0 | self-heals; exclusive `normal` dead until reopen | ~1.7× slower on Chromium (114→196 ms asyncify, 82→160 jspi) |
| E3 | 0 | 0 | as E2 | = M; but `full` exclusive +15-30 % (gate on every commit) |
| E4 | 0 | 0 | as E2 | = M everywhere (medians within IQR) |

**E4 behaviour, per case.** `full`: the aborted commit returns `IOERR`, the next statement already sees the reloaded store. `normal`: the next write gets `SQLITE_BUSY` once (7-8 of 8) or succeeds if the abort was already known at SHARED; with `busy_timeout=1000` it succeeds 8/8 (SQLite releases to `NONE` and retries, which reloads). A read transaction in flight keeps a consistent view (203, 203) and reloads after `COMMIT` (200). Exclusive `normal`: commits returned before the abort was known are lost (normal's contract), every later commit `IOERR` until reopen, reads keep the lost view (204) meanwhile. Suite on E4: Chromium 6113 passed, 7 failed, Firefox IDBMirror files 124 passed, 6 failed — every failure in `vfs_commit_abort`, whose expectations encode P's dead connection.

**Facts found on the way.** `IDBTransaction.abort()` throws once `commit()` was called, so later queued commits cannot be cancelled from the earlier one's `onabort`; a gate request (the first request of a transaction runs only after earlier overlapping ones finished) can. Master `normal` + an aborted spilling commit gives "database disk image is malformed" (8/8). The `BroadcastChannel` `InvalidStateError` on close right after a `normal` commit happens on master too (C10, 6 of 8 runs). A `SQLITE_BUSY` inside an explicit `BEGIN` leaves the transaction open with no lock: a probe's later insert then lived only in that transaction.

## IDBMIRROR-ABORT-RELOAD-ON-REFUSAL — can exclusive `normal` recover without a reopen? 2026-10-03, Playwright 1.62.1 Chromium + Firefox, asyncify + jspi

**Question.** In #371 (F3), exclusive `synchronous=normal` fails every commit after an abort until reopen. Reload the view at the refusal in `#commitTx`, as the `full` error path does (SQLite discards its cache after the error, exclusive mode too)?

**Method.** Recovery probe: exclusive `normal`, abort, then three inserts (the first a 2000-row transaction past `cache_size=10` in the spill arm), abort immediate (then 200 ms) or kept alive 300 ms; 3 runs × 2 builds × 2 engines = 12 per cell; fresh connection counts and `integrity_check`. Plus #371's test file and the 168-probe matrix.

| arm | ordinary commit | refused transaction had spilled to a journal | #371 tests |
| --- | --- | --- | --- |
| F3 (#371 as opened) | dead until reopen; store ok | dead until reopen; store ok | green |
| R1 reload at refusal | one `IOERR`, then recovers; store ok | **aborted rows stored (12/12), or "malformed" / "Page 28: never used" (12/12)** | journal test red |
| R2 = R1 + journal removed on reload | same as R1 | same corruption | journal test red |
| **R3 reload at refusal unless the database has a journal in the VFS** | one `IOERR`, then recovers; store ok (24/24) | dead until reopen; store ok (24/24) | green 3/3 both engines; matrix 0/168 unclean |

**Why R1/R2 corrupt.** After the refused commit SQLite rolls the transaction back through the journal it already holds open, writing the lost view's pre-images onto the reloaded view; the next commit stores them. Removing the journal from the VFS map does not stop a rollback through an open handle.

## IDBMIRROR-CLOSE-BROADCAST — a `synchronous=normal` commit still in flight when its connection closes, 2026-10-03, Playwright 1.62.1 Chromium + Firefox, asyncify + jspi, this container

**Upstream probe** (wa-sqlite `7fcc30df`, its runner, one worker per connection). A sets `normal`, inserts and closes in one worker message; B, open all along, only reads; C counts afterwards. 6 runs × 2 builds × 2 engines = 24 per cell. K1: A's worker lives on; K2: terminated right after the close reply.

| arm | K1 uncaught error | B sees the row, K1 | B sees the row, K2 | stored |
| --- | --- | --- | --- | --- |
| M master | 24/24 `InvalidStateError` | 0/24 | 0/24 | 48/48 |
| S skip the broadcast once closed | 0 | 0/24 | 0/24 | 48/48 |
| D post on a new channel from `oncomplete` | 0 | 24/24 | 10/24 | 48/48 |
| **W `jClose` awaits commits in flight (sent, #372)** | 0 | 24/24 | 24/24 | 48/48 |

B stayed stale at 300 ms and 1.3 s on M; on D and W it saw the row at 300 ms. A stale B's write on M: `database is locked` once then success with no busy timeout (K3 plain insert, K4 `BEGIN IMMEDIATE`, 24/24 each), success at once with `busy_timeout=1000`; then 3 rows, no update lost.

**Close cost**, idle machine, M and W interleaved 3 runs × 15 = 45 per cell, median ms (Firefox rounds to 1 ms): one row then close 0.5→0.5 / 0.3→0.4 (Chromium asyncify / jspi), 0→0 Firefox; close 300 ms later, no change; 2000 × 500-byte rows then close 0.4→34.6 / 0.2→27.0 Chromium, 0→10 / 0→9 Firefox. Statement times unchanged; statement + close with W ≈ the statement with `full` (Chromium 38-52 vs 43-50 ms, Firefox 73-77 vs 75-77).

**Library probe** (`createSQLiteClient`, client A `pragmas: { synchronous }`, client B reading, A writes then `close()`; 8 runs per cell, Chromium jspi + async, Firefox async; a client C counts before B writes). The library's `close()` terminates the worker after `closed`: K2's shape. Pin `7fcc30df` + #371 only: `normal` B stale 8/24 (Chromium 7/16, Firefox 1/8), B's next write `BUSY: database is locked` in those 8, `InvalidStateError` as an uncaught error in the page 4/16 on Chromium (0 Firefox); C counted A's row 48/48; `full` 0/24. W on top of #371 (alias in the probe's rstest config): 0/24 everything. Carried patch installed (#371 + #372 merged, no alias): 0/24 stale, writes all succeed, no page error, both engines.

**Upstream test** (`test/vfs_close_broadcast.js`): master fails the 4 `normal` tests on both builds and engines, `full` passes; with W 108 tests 3/3 both engines; whole suite Chromium 6192 passed. Firefox whole suite on master and branch alike: 3 `OPFSWriteAheadVFS` `vfs_read_freshness` failures (cannot open the second connection) and `sql.test.js` hanging (seen on master alone, Firefox at ~5 % CPU); its `IDBMirrorVFS` part passes in 7-8 s, 3/3 on both.

## IDB-JOURNAL — a journal deletion lost with its worker, `IDBBatchAtomicVFS`, 2026-10-01, Playwright's Chromium and Firefox, this container

**In the library.** Whole `chromium · IDBBatchAtomicVFS` cells, `jspi`/`async` alternated: **3 failed in 21** without a fix (`vfs-folders` "…exactly at the bound", `failed-client` "…before close", `expected +0 to be 1`); **30 of 30** green with fix A, **30 of 30** with fix B. A page-side dump of IndexedDB before the second open: failing runs held the database intact AND a 512-byte `-journal`; passing runs, no journal, 20 of 20. Full matrix with B after the repin: 66/66, 2332 s.

**Upstream's runner, `master`**, a worker commits, replies, holds its thread 1 s and is terminated: `CREATE TABLE` in a new database lost 5/5 per build; 2000 × 2000 B in one transaction on an existing database, default cache, lost 5/5 (2000 rows → 0); terminated on the reply without the hold, 12/20. Fixes A and B: 0/5 everywhere.

**Persistent profiles, both engines** (`.work/worst/journal/`, `.scratchpad/journal-probe/`), kill on the reply, 40 runs: master **27/40 lost on Chromium, 40/40 on Firefox**; a writer that closes and a reader that opens at once, 0/40. `OPFSAdaptiveVFS` and `OPFSAnyContextVFS` (`syncDir` 0, `removeEntry()` not awaited) 0/40 and no journal ever left; `OPFSWriteAheadVFS` (`syncDir` 1) 0/5 in every case.

**Cost**, Chrome, medians of 10 interleaved rounds, idle: new database open + `CREATE TABLE` + close 4.3 ms (master) → 4.7–4.8 ms (A, B); 200 autocommit INSERTs, no journal deleted, 310–321 ms in all three; a 4 MB transaction past the cache 140–147 ms in all three.

**Why `syncDir`.** `sqlite3PagerSetFlags` (SQLite 3.53.0) sets `extraSync` on any VFS reporting `SQLITE_IOCAP_BATCH_ATOMIC`, even at `synchronous=FULL`; a disk journal appears for the first transaction of a new database (`jrnlBufferSize` needs `dbSize > 0`), a cache spill (`pagerStress`), a multi-database commit and a failed batch write.

## 363-SYNC-OFF — another context and `PRAGMA synchronous`, `OPFSAnyContextVFS`, 2026-10-01, Playwright's Chromium, this container

**Method.** A test in wa-sqlite's own runner, wired into `OPFSAnyContextVFS.test.js` in throwaway worktrees of upstream master `fa111290`, with and without #363's `src/` change. Context A sets `synchronous`, creates a table, inserts 3 rows and stays open (closing it would publish its writable); context B, created without reset, counts the rows. Two runs per arm.

| `synchronous` | master | master + #363 |
|---|---|---|
| `OFF` | **B counts 0**, asyncify and jspi, both runs | 3 |
| `NORMAL` | 3 | 3 |
| `FULL` | 3 | 3 |

The table exists for B (A's next transaction began with a read, which closed the writable); its rows do not. Cause, read in SQLite 3.53.0's `pager.c`: `synchronous=OFF` sets `noSync` (L3617) and no `xSync` is ever called, so nothing closes the writable before the unlock.

On the branch with master merged in (`87f687b8`): `OPFSAnyContextVFS` tests 90 passed; master's VFS fails `vfs_xUnlock` on asyncify and jspi (`Expected 8192 to equal 4096`); full suite 15 files, 6031 passed, 80 s.

## 351-REVIEW-2 — #351's second-review head, 2026-10-01, Playwright's Chromium, this container

`3e581623` (open lower bound on the `getAllKeys` range, no one-byte special case): `IDBBatchAtomicVFS` tests 128 passed. Red arm, the guard removed but the closed bound kept: the single-byte test fails on asyncify and jspi, one run: the byte reads back unwritten (`Expected $[0] = 0 to equal 1`) and a read returns 266, `SQLITE_IOERR_READ` (`Expected 266 to equal 0`). Full suite 15 files, 6067 passed, 79 s. Upstream CI green.

## 352-353-REVIEW — wa-sqlite's suite on the revised heads of #352 and #353, 2026-09-30, Playwright's Chromium, this container

**Method.** `npx web-test-runner` in a worktree of each branch after upstream master (`fa111290`) was merged in, `CHROME_PATH` set, `node_modules` shared with the fork's main clone. The runner's totals are assertions, not tests. The red arm is the same commit with `master`'s `IDBMirrorVFS.js` checked out over it, in a detached worktree.

| | #352 `fb327093` | #353 `dd9a514b` |
|---|---|---|
| `test/IDBMirrorVFS.test.js` | 70 passed, 0 failed | 68 passed, 0 failed |
| same file, `master`'s VFS | 66 passed, 2 failed: `asyncify` and `jspi`, `database disk image is malformed` | 66 passed, 2 failed: `asyncify` and `jspi`, `Expected 531 to equal 2` |
| whole suite, 15 files | 6011 passed, 0 failed, 80.5 s | 6009 passed, 0 failed, 78.7 s |

Before the merge #353's file read 34 passed, twice: the `asyncify` build alone, `jspi` skipped without a word. Upstream CI (`build (20.x)`) green on both heads.

## 351-PERSIST — `IDBBatchAtomicVFS` with a persistent journal, wa-sqlite #351's two fixes, 2026-09-30, Chromium 151 / Firefox 153, this container

**Method.** Standalone Playwright pages on a wa-sqlite checkout, asyncify build, a fresh IndexedDB database per run. `jWrite`, `jRead`, `jTruncate`, `jDelete` and `jClose` wrapped from the page: a byte-exact copy of what SQLite writes to every file but the main database; each `jRead` SQLite makes compared with that copy, split between bytes written in the transaction in flight and older ones; at each close the file read back by written runs; every block listed from IndexedDB at the end to count overlaps. "First fix" = #351's head until 2026-09-30 (`5acda54d`); "second fix" = the head since (`8fa53500`, measured replayed on `5be9cd14`, the file byte-identical on the merged branch).

**SQLite does write longer than the block at the start, with `journal_mode=PERSIST`.** Default cache, `INSERT` of 3000 rows then three `UPDATE`s: 895 such journal writes and 4 into an unwritten range. Larger workload, `PERSIST`: 9 046 (default cache) and 11 309 (`cache_size=16`). `DELETE` and `TRUNCATE`: 0. On master (`5be9cd14`) the short sequence logs `RangeError: offset is out of bounds` and the call never settles, Chromium and Firefox.

| scenario, 8 commit-then-rollback rounds | first fix: overlaps / bytes wrong at close | second fix | rollbacks right, either fix |
| --- | --- | --- | --- |
| `PERSIST`, default cache | 10 / 10 125 | 0 / 0 | 8 of 8 |
| `PERSIST`, `cache_size=10` | 707 / 252 528 | 0 / 0 | 8 of 8 |
| `PERSIST`, `journal_size_limit=1000000` | 1 / 3 686 | 0 / 0 | 8 of 8 |
| `PERSIST`, limit 100000, `cache_size=10` | 9 / 3 682 | 0 / 0 | 8 of 8 |
| `DELETE`, `cache_size=10` (control) | 0 / 0 | 0 / 0 | 8 of 8 |

Both engines give the same figures for the second fix. Every overlap under the first fix had its outer block created by the walk's "no block reaches this offset" path; 16 `journal_size_limit` truncations created none.

**What SQLite read.** Bytes of the transaction in flight read wrong: **0**, under either fix, in every run. Under the first fix the wrong bytes were leftovers of earlier transactions, in two places: the 8-byte probe `syncJournal` makes at the next header's offset, and a rollback whose last segment has `nRec` = 0 (SQLite then counts records from the file size and walks stale ones, skipping those whose page number is past the database, until a read is short). Under the second fix only the second remains, and only as `jRead`'s short read across a range never written — master's behaviour, untouched.

**Randomised search** (random `page_size`, `cache_size`, statement mix; 25 rounds a session, each a commit then a verified `ROLLBACK`). First fix: 850 rounds (Chromium 525, Firefox 325), 1 033 023 journal reads, 105 671 wrong bytes, all old, no rollback wrong. Second fix: 725 rounds, 947 752 reads, 0 overlap, 0 byte wrong at close, 0 wrong byte from a read that succeeded. One Firefox session exceeded the 300 s session budget on both fixes alike (about 11 min): slow, not hung.

**At the VFS level**, the first fix fails a direct test: after a 512-byte write filling a gap before a block, a read 8 bytes in returns the old block and one 16 bytes in is short. Both builds.

**Upstream suite, Chromium.** `IDBBatchAtomicVFS` tests: first fix 112 pass and 6 fail (the new case, asyncify and JSPI); second fix 128 pass. Full suite on the merged branch (`fa111290` + PR): 6067 passing. The "2910 passing" reported for the first fix on 2026-09-18 ran no JSPI test: the branch predated upstream's `51784ebf`, and its detection used `WebAssembly.Function`.

**Cost of the second fix**, three alternated runs each, whole workload, quiet machine except the last Firefox pair:

| | first fix, s | second fix, s | median |
| --- | --- | --- | --- |
| Chromium, `PERSIST` spill (~46 000 journal overwrites) | 66.1, 71.5, 68.9 | 73.3, 78.6, 74.2 | +7.7% |
| Chromium, `DELETE` spill | 50.2, 55.8, 54.7 | 50.7, 54.7, 58.1 | 0% |
| Firefox, `PERSIST` spill | 74.7, 74.3, 86.1 | 85.0, 85.3, 97.3 | +14.2% |
| Firefox, `DELETE` spill | 95.2, 61.5, 60.9 | 61.7, 66.4, 86.6 | not usable: two outliers |

**In the library**, patch regenerated on 2026-09-30 for that one file (installed file equal to the PR head, other hunks byte-identical): see `mem:history` for the suite and matrix figures.

## RETRY-OPS — wa-sqlite's shared `retryOps` list, upstream and in the library, 2026-09-29, Chromium 151 / Firefox 153, this container

**Upstream, standalone Playwright probes** against `5be9cd14` (`.work/wa-sqlite-master`), default build unless named, 20 runs per cell, fresh files per run, 12 s hang deadline. A worker that gets an error rolls back and gives up on that database. "BUSY" = `database is locked` reached the application. F1 = `retry()` removes only the ops it awaited; F3 = each call its own list (the diff posted on #341).

**Outcome (2026-09-29):** rhashimoto declined — a call that awaits between retries is still in flight, so two databases in one module is outside the supported case, and the retry mechanism may not outlive JSPI. The fork branch (`784ca1ca` fix, `fe06f806` test) and the library branch (`12f931d`) were deleted; nothing is carried in `patches/`.

| shape | master BUSY / hang | F1 | F3 |
| --- | --- | --- | --- |
| 1 worker × 2 databases, concurrent (`OPFSCoopSyncVFS`) | 20 / 0, both engines | 0 / 0 | 0 / 0 |
| same, `OPFSWriteAheadVFS` | 20 / 0, both engines | 0 / 0 | 0 / 0 |
| 4 workers × 2 databases | 20 / 17 Chromium, 20 / 20 Firefox | 0 / 7 Chromium (ABBA), 0 / 0 Firefox | 0 / 0 (+40/40 Chromium) |
| 4 workers × 3 databases | 20 / 20 both | 0 / 7 Chromium | 0 / 0 |
| 4 × 2 + one injected `createSyncAccessHandle` failure | 20 / 18-20 | both databases fail, 14-20 hang | only the sabotaged one fails, 0 hang |
| controls: 4 × 1 database; 2 calls in flight on one connection | 0 / 0 | 0 / 0 | 0 / 0 |
| 4 × 2, application retries on BUSY (5 ms, ≤200) | 0 / 0, counts right | — | — |

Asyncify showed the same BUSY on master; JSPI broke the harness ("too many columns on t") — two calls in flight in an Asyncify/JSPI module are unsupported (#104), so neither build is evidence. Upstream suite: master and F3 all pass (5830); an earlier variant reading the list at `f()`'s return failed `vfs_read_freshness` on jspi and took 373 s. The fork's test `vfs_concurrent_databases` (own worker — through Comlink it passed on master) fails 3/3 on master for both VFS, passes 3/3 with F3; suite 5834. Probes and raw results: `.scratchpad/341-trigger/`.

**In the library, F3 carried in `patches/` on a throwaway branch (`12f931d`):** `tsc`, `biome ci`, `pnpm test` (1279/8, 750/4, 16/0), conformance (83/14, 79/18), consumer 24/24, and the matrix **66/66 in 2420 s — per cell identical in tests, failures and skips to `main`'s matrix of the same day on the same pin** (`.matrix/2026-09-29T06-27-47-062Z` against `.matrix/2026-09-29T12-26-56-661Z`, compared with `matrix-triage.mjs`). The library does not change behaviour with the fix, as expected: it never has two calls in flight in one module (verified in the code, `mem:architecture`).

## VFS-PILES — the three product piles, cause and cost, 2026-09-18, this container

Full matrix before: **62 cell-failures, 20 groups, 52/66 cells green** (2026-09-16). After the
four wa-sqlite fixes: **1 failing test, 1 group, 65/66 green** — the one a load flake, 3/3 green
alone. Mechanisms in `docs/upstream/`; only the numbers are here.

**`OPFSCoopSyncVFS` — 7, two unrelated causes.**
- Six `DATABASE_NOT_FOUND`: a database opened and never written is 0 bytes, so `jOpen` without
  `SQLITE_OPEN_CREATE` returns `SQLITE_CANTOPEN` and the delete probe read it as absence. Proved
  by returning a distinct code from that branch alone — the error changed — and back when the
  distinct code was moved to the non-empty case.
- Two `sqlite3_open_v2`: reproduced 5 times in 14 full-cell runs (36 %), never in isolation
  (18/18 green). At the failure, `navigator.locks.query()` showed `held=none pending=none` for
  every `ahp:` lock: the holder is a dead context. The file was free **1-12 ms** after the open
  gave up, and a replayed acquisition succeeded in **4-14 ms, 4 of 4** — which read as "one retry
  is enough" and was **wrong**: `Promise.all` leaks the handles acquired beside the one that
  failed, so 25 retries over 2.5 s all failed on `-journal`, the file itself free since 78 ms.

**`IDBBatchAtomicVFS` — 8, one cause, two faces.** A write at 1843200 found the block at 1839104:
one 4096-byte page missing from a contiguous run of **2305**, `queued-before=0` — never written,
not lost. On `jspi` it surfaces as `offset is out of bounds` (Chromium) / `source array is too
long` (Firefox); on `async` the rejection is swallowed and the test hangs its full 30 s.

**`IDBMirrorVFS` — 46, one cause.** `block.set(pData, …)` stores zeroes because `pData` is a
`Uint8ArrayProxy` with no indexed access. Seen on the journal header: written
`d9d505f920a163d700000002`, stored `00000000`. The rollback then reads an empty-looking journal and
undoes nothing — header and file disagree, `2694` pages claimed for 3, or 3 claimed for 2070.

**A storage leak found afterwards, and NOT introduced by those fixes** — 93 blocks with the fix,
93 without. Grown to 531 pages then emptied and `VACUUM`ed back to 2: **531 blocks kept**. It does
not accumulate (a second rollback rewrites the same offsets) and resolves if the database grows
again; the database stays correct throughout.
