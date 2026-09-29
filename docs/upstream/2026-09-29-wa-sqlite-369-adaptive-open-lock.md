# wa-sqlite #369 — an open lock kept by an open that failed

*2026-09-28/29 — measured on Firefox and Chromium 151, in the container*

[pr369]: https://github.com/rhashimoto/wa-sqlite/pull/369
[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365
[pr350]: 2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md

**Why this is here.** `OPFSAdaptiveVFS` is one of the two VFS this library recommends. On Firefox, an open that fails because the database file is held elsewhere keeps the file's Web Lock, and every later open of that file then hangs, in any worker, until the worker that failed terminates. The likely trigger in this library is the one `createVfsInstance`'s comment already describes for another VFS: a worker respawned while the dead one's handle is not reclaimed yet. Same family as [#350][pr350] — something acquired beside a failed acquisition and never released — without its `Promise.all`. Not carried in [`patches/`](../../patches) yet: the exposure in this library is unmeasured.

## How it was found

Checking the other VFS for #350's pattern, after the maintainer asked on [#365][pr365] whether `OPFSWriteAheadVFS` had it ([#367](2026-09-29-wa-sqlite-367-writeahead-open-leak.md), [#368](2026-09-29-wa-sqlite-368-ahp-acquire-leak.md)).

## The mechanism

Without `readwrite-unsafe` handles — the module decides at load, from `FileSystemSyncAccessHandle.prototype.hasOwnProperty('mode')` — `jOpen` opens a `BroadcastChannel`, takes the file's Web Lock, then creates the access handle. If that handle fails, the `catch` sets `lastError` and returns `SQLITE_CANTOPEN`. SQLite does not call `xClose` after a failed `xOpen`, so the lock's releaser and the channel are never touched again. The next open of the file, in the same worker or another, asks for the lock and waits.

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

- **The exposure, untested.** On Firefox this library runs `OPFSAdaptiveVFS` without `readwrite-unsafe`, so on this path. A worker respawned by `handleDeath` while the dead worker's handle is still held (~2 s measured for `AccessHandlePoolVFS`) would take the lock, fail on the handle, and leave the database blocked for the life of that worker. Not reproduced in the library. Whether to carry the fix before it merges is open.
- **`OPFSCoopSyncVFS`'s `#initialize()`** has the same pattern by reading, not reproduced, kept in `mem:follow-ups`.
