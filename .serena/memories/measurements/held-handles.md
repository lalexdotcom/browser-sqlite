# Measurements — a file still held after its holder let go: the OPFS cost per operation, the terminated-holder race, #381 and #382

Part of `mem:measurements`. Split from `mem:measurements/opfs-handles` on 2026-10-16 as it neared 40 000 characters: its last three entries moved here as written, then ADAPTIVE-382. The reports behind the two PRs: `docs/upstream/2026-10-15-wa-sqlite-381-coopsync-held-handle.md`, `docs/upstream/2026-10-16-wa-sqlite-382-adaptive-held-handle.md`.

## OPFS-PROBE — the cost of each OPFS file operation per browser and OS, 2026-10-14, GitHub runners

Moved here from `mem:follow-ups` on 2026-10-16, as written. **Measured 2026-10-14 (OPFS-PROBE, throwaway `scripts/probe-opfs.ts`, commit `6ec7616` on `ci/windows-macos`, removed since — `git show 6ec7616:scripts/probe-opfs.ts` to rerun it, Firefox 155 / Chrome 153, medians of 10):** Firefox on `windows-latest` — `getFileHandle(create)` 54-73 ms, `createSyncAccessHandle` new 104-200 ms / existing 39-78 ms, `close` 118-171 ms, `removeEntry` 141-218 ms, first `getDirectory` 423-968 ms; Chrome there 0.5-2 ms each. Firefox on Linux (runner) 1-4 ms, on `macos-latest` 2-7 ms. Defender's real-time protection is already off on GitHub's Windows image (and forcing it off changed nothing). In the suite: Firefox OPFS tests 7-16× slower than Chrome on Windows (median 4-9 s per test), MemoryVFS and IndexedDB cells equal to Chrome.

## HANDOVER-PROBE — a terminated holder frees its Web Lock before its file, 2026-10-15, GitHub runners (Linux, Windows, macOS) and Safari 26.6.2

Moved here from `mem:follow-ups` on 2026-10-16, as written. **Method:** throwaway `scripts/probe-handover.ts` (last at `6050a53`, on `ci/windows-macos`), a page using only OPFS and Web Locks, run 38698624539 and the next. Worker A holds the lock and a handle, B queues on the lock. A closes then releases → B's first open fails 0/30 everywhere. A is TERMINATED holding the handle → B's first open fails with `NoModificationAllowedError` — Chrome Linux 20/30 (free after median 7 ms, max 7), macOS 11/30 (22/31 ms), Windows 27/30 (10/41 ms); Firefox Linux 18/30 (10/12 ms), macOS 12/30 (28/76 ms), **Windows 19/30 (96/141 ms)**; always free in the end. So every engine and OS has the race; Windows Firefox widens the window tenfold, and its 30 s open timeouts make the library terminate workers that may hold handles. A first hypothesis — a clean close-then-release racing — was refuted (0/30 on all six).

**More measured 2026-10-15 (runs 38709139447, 38710749684):** the longest wait for the file, holder terminated while awaiting / in a JS loop / in a WASM loop — Chrome 8-34 ms, Firefox Linux 11, macOS 40, **Windows 956 ms** (JS loop; 411 in WASM). Safari 26.6.2: `createSyncAccessHandle` on a held file throws `InvalidStateError`, but **`removeEntry` on a held file SUCCEEDS** (so upstream's `maybeReset`, which retries only `NoModificationAllowedError`, is fine on Safari); terminated while awaiting or in a JS loop it releases with the lock (0/30), and a worker spinning in pure WASM is never terminated. Upstream's only name checks for a held file are in its test harness (`maybeReset`, `vfs_open_last_error` — the latter in the #373 PR plan); no VFS retries one.

## COOPSYNC-381-WINDOWS — two CoopSync clients on Windows Firefox with wa-sqlite #381 carried, 2026-10-16, GitHub `windows-latest`

**Method:** `coopsync-handover.test.ts`'s three tests re-enabled on Firefox on Windows on a throwaway branch off `fix/coopsync-held-handle` (#381 as a `pnpm patch`), each attempt logging its duration and failures; `tests-windows.yaml` (`BSQ_TIME_SCALE=4`, so the tests' default open timeout is 120 s), Firefox 155, runs 38879842407 (no log) and 38886407473 (log).

- **No failed statement in 54 completed attempts** across the three tests — no open `TIMEOUT`, no raw error. Before #381 (run 38693552137, the library's 30 s open timeout then): the first test met 12 × `TIMEOUT` and 2 × `undefined: No modification allowed` in 20 attempts.
- **An attempt takes 25-60 s** (two clients, 3 batches of 8 statements; ~150 ms on Linux in the container), 50-90 s when a timed-out test's loop overlapped the next test. 20 attempts outlive the 480 s test bound: all three tests failed on it alone, and the file then left held handles behind (`.cs`, `.ahp-*`).
- **With 3 attempts on Windows Firefox** (`ef36a8f`), run 38891519544 green: the three tests 76 s, 64 s, 45 s; Chrome on Windows with 20 attempts 22 s, 60 s, 10 s. Whole run 343 files, 2509 passed, conformance 162/32, 28 min.
- Not measured: the duration of each open, so whether the library's 30 s default suffices for a second client there.
- Seen beside it: `results.test.ts` › "decodes short, long and invalid texts as before" on Firefox `OPFSAdaptiveVFS/jspi` took 85 s against its 120 s bound in the green run, and exceeded it in both probe runs (load of the overlapping loops, likely, not shown).

## ADAPTIVE-382 — `OPFSAdaptiveVFS` after a terminated holder, master against the #382 change, 2026-10-16

**Method:** #381's test shape run for `OPFSAdaptiveVFS` (A terminated mid-`count(*)` while B queues on the lock, 10 rounds per build, B bounded at 10 s; a probe variant then had B query again and a third connection C open and query, each bounded), through the fork's WebDriver harness (`probe/stock-browsers`) on a throwaway branch, deleted since. Firefox 155 and Chrome 153 in the container; Firefox 157 on `windows-latest` and Safari 26.6.2 on `macos-26`/`macos-latest` through the fork's Actions (run 38909211292). The numbers, the cause read in the code and the PR's own verification are in the #382 report; in short:

- **`master`, Firefox:** `asyncify` — B hung 4-6 rounds in 10 on Linux, 7-8 on Windows, and C hung each time (the connection kept the Web Lock with no handle); `jspi` — B's raw `NoModificationAllowedError` 5-7 in 10 on Linux, 8-10 on Windows, then `disk I/O error`, and B's `close()` never returned.
- **With the change:** 0 failures on Firefox Linux (4 runs) and Windows (2 runs, 17 and 14 retries), all retries on `NoModificationAllowedError`.
- **Chrome:** 0 either way — `readwrite-unsafe`, so `WebLocksMixin`'s `jLock()`. **Safari:** no retry ever fired on either arm; its few "hung" rounds are A's `count(*)` running on, since Safari does not terminate a worker inside WebAssembly (HANDOVER-PROBE).
- Beside it: `vfs_handover`'s "re-prepared statement" test fails now and then on `OPFSAdaptiveVFS`/`asyncify` with `SQLITE_SCHEMA`, on Firefox AND Chrome, so unrelated to the hand-over; cause not shown.
- **The survey of every lock-then-file site in upstream `src/` (2026-10-16, read at `6238f532`):** covered — `OPFSCoopSyncVFS.#requestAccessHandle()` (#381), `OPFSAdaptiveVFS.jLock()` (#382), `OPFSCoopSyncVFS.#initialize()`'s `.ahp-*` sweep (#362); outside the family — `OPFSWriteAheadVFS`'s `.session-*` sweep (ignores every error), its `#open` lock (serializes opens, proves nothing about the file), `AccessHandlePoolVFS` (no lock), `OPFSPermutedVFS`/`WebLocksMixin` (`readwrite-unsafe` only), the IndexedDB VFS, `WriteAhead.js` (handles already open); `OPFSAnyContextVFS`'s `createWritable()` left unmeasured. **Two `OPFSAdaptiveVFS` candidates measured with throwaway variants of the test**, Firefox 155 Linux and 157 Windows (fork run 38916578047), 10 rounds per build and run: *a hot journal* — A terminated mid-transaction with `cache_size = 10`, the `-journal` (22 016 B) present at B's read every round — with #382 60/60 rolled back to B's 1 000 rows, so the journal, opened without a lock in `jOpen()`, was never still held; on `master` the failures were all `jLock()`'s (Windows: `asyncify` 20/20 hung, `jspi` 19/20 raw). *An open right after the termination* (B's worker ready before) — 120/120 ok on both arms (Windows opens 95-602 ms): `jOpen()`'s single attempt never met the held file. Nothing to add to #382.

## POST-381 — the library's first-open retry after #381: never a second attempt, 2026-10-23, this container (Chrome 153, Firefox 155)

**Why measured.** `openWithRetry` (`src/worker/worker.ts`) retried a first open (`afterDeath === undefined`) of the VFS declaring `exclusiveFileHandle: true`, `OPFSCoopSyncVFS` and `AccessHandlePoolVFS`, within `OPEN_RETRY_BUDGET_MS` (2.5 s), when `lastError` named a held file. With #381, `OPFSCoopSyncVFS`'s `#requestAccessHandle()` (reached from `jOpen()`) retries a held file itself for 5 s with the Web Lock kept, so its first held failure arrives past the library's deadline and the loop never made a second attempt. `AccessHandlePoolVFS`'s `jOpen()` is synchronous, touches no OPFS and the VFS has no `lastError`: the loop gave up at the first failure, always (read).

| arm | `open-retry` › "succeeds once the holder lets go", `OPFSCoopSyncVFS/sync` × chrome/firefox × not-isolated/isolated |
|---|---|
| first-open retry off for `OPFSCoopSyncVFS`, #381 in (the patch at `6b59b231`) | green 4/4 |
| retry off and #381 out (installed file = `6b59b231` + #386 only) | red 4/4: `WORKER_CRASHED`, `NoModificationAllowedError` on `createSyncAccessHandle` |

The whole first-open branch removed, every pair of both VFS (`sync`/`jspi`/`async`), Chrome and Firefox, `--full`: 39 cells, 1 534/1 534 files, 8 644 tests. **Acted on the same day** on `refactor/post-381-open-retry`, after #381 merged and was pinned (`8a8bc2ee`): the branch and `openWithRetry`'s `vfs` parameter removed, `exclusiveFileHandle` kept for the test planner (`requires:exclusive-file-handle`); `pnpm test` 371/371 files. The after-death retry stays: `busy` waits until `openDeadline` (Safari, WebKit 328618; unmeasured here), and `OPFSAdaptiveVFS`'s `xOpen` without `readwrite-unsafe` is not #382's (`jLock()`).

## JOURNAL-PROBE — OPFS calls per autocommit write, per VFS and `journal_mode`, 2026-10-29, this container

**Method.** A throwaway scratchpad page (not kept): a module worker loads wa-sqlite as patched in `node_modules` (upstream VFS classes, no library), wraps `getFileHandle`, `getDirectoryHandle`, `removeEntry`, `createSyncAccessHandle` and the access handle's `close`/`flush`/`truncate`, and counts them by file suffix. Per configuration: open, apply the pragmas, 3 warm-up `INSERT`s, then 40 autocommit `INSERT`s counted and timed, then the same 40 in one transaction. `OPFSAdaptiveVFS` on `jspi` (both engines have it), the others on `sync`. Stock Firefox 155 and Chrome 153, Linux, one run each.

| VFS · `journal_mode` | OPFS calls per commit (the same on both engines unless said) | median ms/commit Firefox / Chrome |
|---|---|---|
| `OPFSAdaptiveVFS` · `delete` (its default) | on `-journal`: `getFileHandle(create)`, `createSyncAccessHandle`, `close`, `removeEntry`, 2 `flush`; `getFileHandle` without create on `-journal` and `-wal` (SQLite's `xAccess`); 1 `flush` of the database | 3 / 2.3 |
| `OPFSAdaptiveVFS` · `truncate`, `persist` | **refused on Firefox** (`disk I/O error`: `jFileControl` accepts only `off`/`memory`/`delete`/`wal` without `readwrite-unsafe`), the mode stays `delete`; accepted on Chrome and worse there: 2 `createSyncAccessHandle` + 2 `close` on `-journal` per commit | — / 3.0-3.2 |
| `OPFSAdaptiveVFS` · `memory` | the two `getFileHandle` without create, 1 `flush` | 0 / 1.1 |
| `OPFSCoopSyncVFS` · `delete` | no metadata call: `truncate` of `-journal` (its `jDelete`), 3 `flush`; `truncate` refused (`disk I/O error`) on both engines | 1 / 0.1 |
| `OPFSWriteAheadVFS` | no OPFS call at all | 1 / 0.1 |
| `AccessHandlePoolVFS` · `exclusive` + `wal` (the library's default) / `delete` | none / 6 `flush` + 1 `truncate` of pool files | 0-1 / 0-0.1 |

The one-transaction phase made the same calls as one autocommit write: the cost is per commit, not per row. Firefox's timer rounds to 1 ms.

**On `windows-latest` (2026-10-29, run 40968323465, throwaway `scripts/probe-journal/` at `1881cd87` on the local branch `probe/journal-windows`, the same page; the `truncate`/`persist` rows fell back to `delete` on Firefox, so `OPFSAdaptiveVFS · delete` was measured three times):** the same calls per commit as on Linux, every VFS and engine.

| ms per commit, median (mean) | Firefox | Chrome |
|---|---|---|
| `OPFSAdaptiveVFS` · `delete` | **150-164 (150-306)** | 22.7 (22.8) |
| `OPFSAdaptiveVFS` · `memory` | 9 (15) | 6.6 (6.8) |
| `OPFSCoopSyncVFS` · `delete` | 13-15 (15-23) | 11.2 (12) |
| `OPFSWriteAheadVFS` | 2 (1.8) | 0.6 (0.7) |
| `AccessHandlePoolVFS` · `exclusive` + `wal` / `delete` | 1 (0.6) / 21 (22) | 0.2 / 17.2 |

Firefox's cycle on `-journal`, mean ms each over the three runs: `getFileHandle(create)` 17-34, `createSyncAccessHandle` 38-72, `close` 32-69, `removeEntry` 42-86 — about half OPFS-PROBE's 2026-10-14 figures on another runner; the `getFileHandle` lookups without create 0.4. A `flush` costs 3-13 ms on both engines there, which is what Chrome's and CoopSync's per-commit times are made of. **Reading:** without `readwrite-unsafe` (Firefox, Safari), `OPFSAdaptiveVFS` creates, opens, closes and removes its `-journal` at every write transaction — exactly the cycle of Mozilla bug 2072928 — and on Windows Firefox that cycle is ~95 % of a commit (`memory` takes it from 150-164 to 9 ms). `results.test.ts`'s ~630 ms per commit there ran under the suite's parallel jobs (`mem:follow-ups/firefox-opfs-fsync`). The other VFS keep every file and handle they use between commits. Seen on the way, not investigated: `OPFSWriteAheadVFS` and `AccessHandlePoolVFS` in `wal` called no `flush` at all per commit, on both engines and OSes.
