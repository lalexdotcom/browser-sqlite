# wa-sqlite — an open that fails asynchronously loses its cause

*2026-09-21 — found while closing the two matrix cells it had made unreadable, measured on Chromium*

**Why this is here.** [browser-sqlite](../../README.md) does not carry this change: it fixes no failure, it makes an existing one legible. The defect it names is what forced the `NoModificationAllowedError` behind [#350](2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md) to be found by hand, instrumenting a `catch`, rather than read off an error message. That report ends by calling it a separate subject; this is that subject.

## The shape of the defect

`OPFSCoopSyncVFS` cannot open a database synchronously. `jOpen` pushes the work onto `retryOps`, returns `SQLITE_BUSY`, and SQLite calls it again once the work has settled. The second call reads the result and answers.

When the asynchronous phase fails, it stores an invalid `PersistentFile` as its only signal and calls `console.error(e)`. The retried `jOpen` sees `!persistentFile.fileHandle` and returns `SQLITE_CANTOPEN` — from a branch that has no error of its own. The cause never leaves the worker's console.

```
jOpen('demo', …, SQLITE_OPEN_MAIN_DB)   ->  SQLITE_BUSY       // work started
  #requestAccessHandle throws NoModificationAllowedError      // console only
jOpen('demo', …)                        ->  SQLITE_CANTOPEN   // cause gone
vfs.lastError                           ->  undefined
```

A caller is left unable to tell a file held by another context — retryable, and the ordinary case when a worker has just been terminated — from a file that is not there.

## Why this branch and no other

Mapping every non-OK return of the VFS against its `lastError` assignments: the synchronous catch of `jOpen`, and `jDelete`, `jAccess`, `jClose`, `jRead`, `jWrite`, `jTruncate`, `jSync`, `jFileSize`, `jFileControl` all record the cause before returning. The returns that do not are results rather than failures — `SQLITE_BUSY` from `jOpen` and `jLock`, `SQLITE_IOERR_SHORT_READ`, `jFileControl`'s `SQLITE_NOTFOUND`.

So the asynchronous open is the only error return that reports nothing. That makes it, for the same reason, the only path where `xGetLastError` can serve a **stale** message: nothing ever clears `lastError`, so a `SQLITE_CANTOPEN` raised here is reported with whatever an earlier call left behind.

This is worth stating precisely because the first reading was the opposite one — that staleness is a general weakness of a field nobody clears. It is not: the field is written on every path that reports an error, and one line closes the only gap.

## Measured, both ways

The suite's own harness could not see it, which is the second finding. `test/test-worker.js` exposes the VFS behind a proxy whose getter returns only functions, so a test can call `jOpen` and read its return code but cannot read the state the call left behind. Probed directly: after a `jOpen` that fails synchronously — a path that **does** set `lastError` — `await vfs.lastError` answers `undefined`. One line makes plain properties pass through.

With that, `test/vfs_open_last_error.js` holds the database file from a worker of its own and drives `jOpen` directly, which is the caller's situation when `sqlite3_open_v2` is what failed: there is no connection to ask `sqlite3_errmsg`.

| | `default` | `asyncify` |
| --- | --- | --- |
| `upstream/master` | FAILED, `Expected null to be truthy` | FAILED, same |
| with the fix | OK | OK |

The whole upstream suite with both changes: **2901 tests, 13 files, 0 failures.**

## What it would buy us, if it lands

`src/worker/worker.ts` already reads `vfsInstanceSeen.lastError` on an open failure and formats it as `name: message` into the error's `detail`; the instance is fresh per `open()`, so the value cannot be stale. `WORKER_CRASHED: sqlite3_open_v2` would carry `NoModificationAllowedError: …` instead of nothing. Nothing on our side changes.

## Posted upstream

Not yet — the branch is `fix/coopsync-open-last-error` on the fork. The PR number goes in this file's name and in the table of [`README.md`](README.md) when it is opened.
