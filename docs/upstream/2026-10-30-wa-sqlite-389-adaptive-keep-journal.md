# wa-sqlite #389 — `OPFSAdaptiveVFS`: keep the journal's access handle between transactions

*2026-10-30 — measured on Chrome 153, Firefox 155 and Safari 26 (container, Linux arm64; GitHub `windows-latest` and `macos-26`), wa-sqlite `master` `66336807`*

[pr389]: https://github.com/rhashimoto/wa-sqlite/pull/389
[bug2072928]: https://bugzilla.mozilla.org/show_bug.cgi?id=2072928

**Why this is here.** The library's follow-up on Firefox's OPFS metadata fsyncs (`mem:follow-ups/firefox-opfs-fsync`) counted OPFS calls per commit on every VFS (JOURNAL-PROBE, `mem:measurements/held-handles`): without `readwrite-unsafe`, `OPFSAdaptiveVFS` creates, opens, closes and removes its `-journal` at every write transaction; the other VFS make no metadata call per commit. On Windows Firefox that cycle was ~95 % of a commit (150-164 ms against 9 ms with `journal_mode = MEMORY`). Nothing on the library's side removes it: `MEMORY` gives up crash safety, and the VFS refuses `TRUNCATE`/`PERSIST` without `readwrite-unsafe`.

## Shape, decided with the user

- **The fix is upstream's**, in the one VFS that pays the cycle; `OPFSCoopSyncVFS` already keeps its journal and truncates it, which became the PR's lead argument.
- **Argued for the engines without `readwrite-unsafe`, not for Firefox** (user: rhashimoto is not moved by a Firefox-only optimisation, "FF n'est qu'un unsafe-less"). Safari was measured for that reason; Mozilla bug [2072928][bug2072928] was left out of the body.
- **Gains stated as one range across browsers and OS** (user): "from about 2× to 10× faster depending on the browser and OS", hand-over "up to 2× faster".
- **Readability pass before sending** (user: rhashimoto asks for the most finished readability), `mem:conventions/upstream`.
- **Tests on Chrome only**, as upstream runs them.

## The change

`src/examples/OPFSAdaptiveVFS.js`, only where `readwrite-unsafe` is missing. A database `File` gets `journalAccessHandle`, a journal `File` gets `database` (its owner). `#getJournalOwner(pathname)` finds the open main database whose handle this connection holds (`handleLockReleaser` set); `#getKeptJournal(pathname)` returns its kept journal handle. `jOpen` of a journal reuses the kept handle or opens one and hands it to the owner; `jClose` of a journal leaves it open; `jDelete` truncates it (and flushes when `syncDir`); `jAccess` reports it only while `getSize()` is non-zero; `#releaseJournal(file)` closes it before the database's handle is released (the two hand-over sites in `jLock`'s `onmessage` and `jUnlock`) and in the database's `jClose`. Fork branch `lalexdotcom:opfsadaptive-keep-journal`, one commit `2352be7c`.

**Why the hot-journal check stays correct.** SQLite's `hasHotJournal()` calls `xAccess` on the journal, then opens it and reads its first byte. A kept journal is never removed, so `xAccess` would always answer "exists" and every read transaction would open it: reporting it only while it has content keeps that path for a real hot journal. A journal left by a terminated connection is not kept by anyone, so `xAccess` falls back to the directory lookup, SQLite opens and reads it, rolls back, and `xDelete` truncates it.

## Measured

Throwaway probe pages (`.scratchpad/probe-journal-fix/`, then the branch `probe/journal-fix-windows`, commits `d792e592` and `d1fa9819`): wa-sqlite at `66336807` with the VFS swapped per arm, one connection per worker, OPFS calls counted by wrapping `getFileHandle`, `removeEntry`, `createSyncAccessHandle` and the handle's `close`/`flush`/`truncate`. 40 autocommit single-row `INSERT`s after 3 warm-ups, two passes per arm; median ms per commit.

| ms per commit (median) | master | change |
|---|---|---|
| Firefox, Linux (container) | 2-3 | 1 |
| Firefox, `windows-latest` (run 41013700863) | 203 / 399 | 17 / 67 |
| Firefox, `macos-26` (run 41019570376) | 16-23 | 3-4 |
| Safari 26, `macos-26` (same run) | 3-4 (mean 4.7-6.4) | 2 (mean 1.7-2.5) |
| Chrome, every OS | unchanged: `readwrite-unsafe`, the new path is never taken | |

Per commit with the change, without `readwrite-unsafe`: no `getFileHandle(create)`, `createSyncAccessHandle`, `close` or `removeEntry` on the journal; one `getFileHandle` lookup of `-wal`, three `flush`, one `truncate`. Hand-over, two connections inserting in turn (ms per round): Windows Firefox 686 → 333, macOS Firefox 53 → 26, Safari 38 → 18, Linux Firefox 7 → 5-6. The Windows passes differ by the runner's `flush` cost (4-10 ms in the first, 19-26 ms in the second).

**Crash recovery.** A connection with `cache_size = 2` updates every row of a 201-row table in an open transaction, its worker is terminated, a second connection reads: master and change 201/201 and `integrity_check` ok on every engine and OS; a mutant whose `xAccess` never reports the journal reads 1/201. The first version of this scenario only inserted rows; the spilled pages went past the database size in the header, so the mutant passed as well, and the scenario was redone on existing pages.

## The test, and how it was falsified

`test/vfs_journal_handle.js` and `test/vfs_journal_handle-worker.js`, registered in `test/OPFSAdaptiveVFS.test.js` for both builds. The worker deletes `FileSystemSyncAccessHandle.prototype.mode`, as `vfs_open_lock_recovery-worker.js` does, **and makes `createSyncAccessHandle()` ignore its options**: Chrome still honours `{ mode: 'readwrite-unsafe' }`, which `jOpen` always passes, so without the second step the journal handle stays shared and a connection that never releases it goes unnoticed. Three cases: no `createSyncAccessHandle()`/`removeEntry()` on the journal over five autocommits; two connections in turn plus a rollback; the crash above (the next connection waits until the terminated worker's handles are free, since every engine releases its Web Locks first).

Chrome 153, `test/OPFSAdaptiveVFS.test.js`, both builds, after the readability pass:

| arm | result |
|---|---|
| the change | green (5 runs of 5 before the pass, 1 of 1 after) |
| `master` | red on the first case: `createSyncAccessHandle` 5, `removeEntry` 5 |
| `xAccess` never reports the journal | red on the crash: 1 row of 201 as committed |
| the journal's handle not released at hand-over | red on the hand-over: `disk I/O error` |

Whole upstream suite on Chrome with the change (before the test was added): 15/15 files, 6 492 assertions, 0 failed.

## Posted upstream

PR [#389][pr389], opened 2026-10-30 from `lalexdotcom:opfsadaptive-keep-journal` onto `master` at `66336807`, one commit (`2352be7c`). The body: the cycle and why `TRUNCATE`/`PERSIST` are not available, `OPFSCoopSyncVFS`'s precedent, the change point by point, the ranges, the cost (one more handle per database, a zero-length `-journal` left in the directory, the journal's handle closed at hand-over), the test and its emulation of exclusive handles. It does not mention this library or the Mozilla bug. No conflict with #386, #387 or #388 (none touches `OPFSAdaptiveVFS.js` or its test file).

## What stays ours

- **Not carried in `patches/` yet.** Carrying it is the next step `mem:conventions/upstream` orders after the PR, with a CHANGELOG entry that leaves at the repin that brings it.
- **The library's follow-up stays open** on the 30 s default open timeout on Windows Firefox, unrelated to this change.
