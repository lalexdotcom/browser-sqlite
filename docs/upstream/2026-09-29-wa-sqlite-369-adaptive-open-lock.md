# wa-sqlite #369 — an open lock kept by an open that failed

*2026-09-28/29 — measured on Firefox and Chromium 151, in the container*

[pr369]: https://github.com/rhashimoto/wa-sqlite/pull/369
[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365
[pr350]: 2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md

**Why this is here.** `OPFSAdaptiveVFS` is one of the two VFS this library recommends. On Firefox, an open that fails because the database file is held elsewhere keeps the file's Web Lock, and every later open of that file then hangs, in any worker, until the worker that failed terminates. Same family as [#350][pr350] — something acquired beside a failed acquisition and never released — without its `Promise.all`. Carried in [`patches/`](../../patches) since 2026-09-29; measured since, this library is not exposed to it (below).

## How it was found

Checking the other VFS for #350's pattern, after the maintainer asked on [#365][pr365] whether `OPFSWriteAheadVFS` had it ([#367](2026-09-29-wa-sqlite-367-writeahead-open-leak.md), [#368](2026-09-29-wa-sqlite-368-ahp-acquire-leak.md)).

## The mechanism

Without `readwrite-unsafe` handles — the module decides at load, from `FileSystemSyncAccessHandle.prototype.hasOwnProperty('mode')` — `jOpen` opens a `BroadcastChannel`, takes the file's Web Lock, then creates the access handle. If that handle fails, the `catch` sets `lastError` and returns `SQLITE_CANTOPEN`. SQLite then calls `xClose` on the file, since wa-sqlite's `libvfs_xOpen` sets `pMethods` whatever the JavaScript `xOpen` returns. But `jClose` only closes the access handle: the lock's releaser and the channel are never touched again. (The PR first said SQLite does not call `xClose` here; the maintainer corrected it, see below.) The next open of the file, in the same worker or another, asks for the lock and waits.

## Reproduced

A worker holds an exclusive handle on the database file, another opens it with `OPFSAdaptiveVFS` and fails, the holder lets go, and the file is opened again. Playwright with persistent profiles, 2 runs per case; each open bounded at 10 s.

| after the failed open | Firefox, `master` | Firefox, with the change | Chromium |
| --- | --- | --- | --- |
| locks held (`navigator.locks.query()`) | `OPFS:/<file>` | none | none |
| open in another worker | **hangs** | ok | ok |
| open again in the same worker | **hangs** | ok | ok |
| after the failing worker terminates | ok | ok | ok |

Chromium has `readwrite-unsafe` and takes no lock on open, so it never shows the defect. Probes in `.work/worst/leak/`, runner `.scratchpad/365-lib-arms/adaptive-runner.mjs`.

## The change and its test

The `catch` releases the lock, closes the channel and removes the file from `mapIdToFile`. Nothing changes on success or on the `readwrite-unsafe` path.

Upstream's suite runs Chromium only, so `test/vfs_open_lock_recovery.js` forces the other path: its worker deletes `FileSystemSyncAccessHandle.prototype.mode` before importing the VFS. Holder, failed open, release, reopen in the same worker, bounded at 5 s and reported as `hung`. It reuses #350's holder, exported for this — the same one-line change as #367's.

| | asyncify | jspi |
| --- | --- | --- |
| `master` | `Expected 'hung' to be 'opened'` | same |
| with the change | 70 tests of the file pass, 3 runs of 3 | |

The whole suite on the branch: 5792 passed, 0 failed.

## Posted upstream

PR [#369][pr369], opened 2026-09-29 from `lalexdotcom:fix/adaptive-open-lock-leak`. Two commits, the fix then the test, cut from `master` at `e6e01ae1`; the branch merges cleanly with `master` (#365) and with #367's branch. Upstream CI on the head commit is green — [run 36529731910](https://github.com/rhashimoto/wa-sqlite/actions/runs/36529731910), `build (20.x)`, the only check.

It does not mention this library, per the standing rule.

## What stays ours

- **No exposure here, measured 2026-09-30.** On Firefox this library runs `OPFSAdaptiveVFS` without `readwrite-unsafe`, so on this path — but a worker whose open fails is terminated, and the lock it kept goes with it. With the fix reversed, a client opened after the failed one succeeded 7 times of 7, the failed client closed first or not (`mem:measurements`, LEAK-LIB).
- **`OPFSCoopSyncVFS`'s `#initialize()`** has the same pattern by reading. Forced on 2026-09-30, it keeps the handles and the lock of the failed instance and blocks nothing: every later `create()` succeeds (`mem:measurements`, LEAK-LIB). No PR.

## The maintainer's answer, 2026-10-02

rhashimoto quoted the description's "SQLite does not call xClose after a failed xOpen". He made his local `jOpen` fail at once, and showed `jClose` called from `sqlite3_open_v2()`. From that, he found the primary defect in `jClose`, which never calls `openLockReleaser`, and said the `jOpen` change was still a good idea in addition.

**He was right, measured the same day** (369-XCLOSE in `mem:measurements`):

- **The source.** `libvfs_xOpen` sets `pMethods` regardless of the result (`src/libvfs.c` L122-146). SQLite's `sqlite3OsClose` calls `xClose` whenever `pMethods` is set (os.c L81), for instance from `sqlite3PagerOpen`'s failure cleanup (pager.c L5033).
- **The trace.** `jClose` follows the failed open on Chromium and Firefox, on both builds.
- **The fix.** A `jClose` that calls `openLockReleaser` recovers on its own, like the original change.
- **No other case.** An open closed with no statement does not keep the lock, because `sqlite3_open_v2` reads the header, which releases it.
- **One trap.** A `jClose` that also closes the request channel, without releasing the access-handle lock, made the next open in another worker hang. Master leaves that channel open after a close, and a later request on it is what releases the lock.

**Revised and answered the same day.** The branch got:

- `dd5a5c98`, where `jClose` releases the open lock and the `jOpen` comment no longer claims `xClose` is skipped;
- a merge of upstream master (`5bde491c`, with #367 and #368, byte-identical to our heads), as `71537545`.

The PR's test fails with master's VFS on both builds and passes 3 runs of 3. The whole suite has 6092 passed, 0 failed. The description now explains the mechanism through `jClose` and drops the merge-order note, since #367 brought the holder's export.

[Comment 5960176392](https://github.com/rhashimoto/wa-sqlite/pull/369#issuecomment-5960176392) concedes the error, describes the move, and says why `jClose` leaves the channel alone.

## Second exchange, 2026-10-03

rhashimoto asked whether there was a reason not to release the access-handle lock, if held, and close the channel in `jClose`. There was none beyond keeping the change small: 369-XCLOSE had already measured that variant (`closeAll`) green everywhere.

`87ed5aaf` does it: after closing the handle, `jClose` releases both locks and closes the channel. Measured:

- **wa-sqlite's suite** (Chromium, `readwrite-unsafe` path): the PR's test passes 3 runs of 3, and the whole suite has 6092 passed, 0 failed.
- **The 369-XCLOSE probe on the branch's exact file**, Chromium and Firefox, both builds, two passes: every scenario ok. Master still hangs after the failed open.

The description's "The change" now names both locks and the channel, and [comment 5966329411](https://github.com/rhashimoto/wa-sqlite/pull/369#issuecomment-5966329411) answered.

## Merged

**Merged on 2026-10-03** by rhashimoto, as `d7e7d6b1` on `master`, its `OPFSAdaptiveVFS.js` byte for byte the PR's last head `87ed5aaf`. The patch had still carried the first head's hunk; the repin of 2026-10-03 to `7fcc30df` brought the last head into the pin and dropped the hunk.

