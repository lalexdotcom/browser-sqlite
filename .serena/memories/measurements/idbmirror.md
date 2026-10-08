# Measurements — `IDBMirrorVFS`: an aborted commit, a close with a commit in flight (wa-sqlite #371, #372)

Part of `mem:measurements`, which indexes every entry; its rules apply here. Moved here verbatim from `mem:measurements/wa-sqlite-prs` on 2026-10-08.

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
