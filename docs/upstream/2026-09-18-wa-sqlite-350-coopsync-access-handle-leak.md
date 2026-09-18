# wa-sqlite #350 — a failed access handle acquisition leaks the others, and `OPFSCoopSyncVFS` never opens that database again

*2026-09-18 — found while diagnosing two matrix cells, measured on Chromium*

**Why this is here.** [browser-sqlite](../../README.md) carries a patch to `OPFSCoopSyncVFS` ([`patches/wa-sqlite@1.1.2.patch`](../../patches)); this is its third hunk, upstream as [rhashimoto/wa-sqlite#350][pr350]. It was not looked for: it surfaced as the reason a fix of ours could not work, and it is the more serious of the two defects because it makes a legitimate failure permanent.

[pr350]: https://github.com/rhashimoto/wa-sqlite/pull/350

## What was being chased

Two cells of our VFS matrix failed on `chromium · OPFSCoopSyncVFS/sync` with `WORKER_CRASHED: sqlite3_open_v2` and nothing else — `lifecycle.test.ts :: restarts the slot once` and `long-query.test.ts :: is presumed dead when it never answers the stop request`. Both kill a worker inside a `step()` and reopen the same database at once. A worker killed that way keeps its OPFS access handles for up to ~2 s on Chromium while its Web Locks go immediately (HANDLE-CORPSE, `mem:measurements`), so the replacement meets a file held by something that answers nothing.

The message carried no cause, and that is the first thing worth recording: **`jOpen`'s asynchronous phase swallows its error**. It catches, calls `console.error`, stores an invalid `PersistentFile` as the only signal, and the retried open returns `SQLITE_CANTOPEN` with no `lastError`. A caller cannot tell a held file from a missing one. Instrumenting that catch is what produced the `NoModificationAllowedError` and, with it, everything below. This is not fixed by #350 — it is a separate subject, and a candidate for the next PR.

## What the census said

At the moment of the failure, `navigator.locks.query()` reported `held=none pending=none` for every `ahp:` lock. Nobody holds the lock the VFS uses to coordinate the handle, yet the file refuses. That is the signature of a dead holder: a terminated context releases its Web Locks at once and its access handles some time later, so no protocol can help — only waiting can.

So the fix on our side was a retry around `sqlite3_open_v2`, and a sonde had said it would work: replaying the acquisition inside the catch succeeded in 4-14 ms, 4 times out of 4.

## The retry never succeeded, and that is the defect

With the retry in place, the open failed for its whole 2.5 s budget: **25 attempts, every one of them on `-journal`** — while the main file had been free since 78 ms in.

`#requestAccessHandle` acquires the database file and its sidecars (`''`, `-journal`, `-wal`) with `Promise.all`, which rejects as soon as one acquisition does, while the others are still in flight. The `catch` calls `#releaseAccessHandle` — whose own comment says *"Close any of the potentially opened access handles"* — but at that instant those acquisitions have assigned nothing, so it closes nothing. They complete a moment later and assign handles to persistent files the next attempt replaces through `#createPersistentFile`.

One access handle leaks per failed attempt, on the sidecars rather than on the file that failed. After a single failure the instance blocks itself, and it blocks itself for good: every later open fails on a file it is holding, so nothing about the original cause matters any more.

The sonde had not seen it because it replayed **once**. The leak only shows from the second attempt, which is exactly what a retry does — the measurement was true and the conclusion drawn from it ("a retry suffices") was wrong.

## Measured, both ways

[`repro/coopsync-access-handle-leak.mjs`](repro/coopsync-access-handle-leak.mjs) — self-contained, a plain wa-sqlite checkout and Playwright. A worker holds an exclusive handle on `/demo`, a second worker's VFS fails to open it, the holder releases, the same VFS instance opens again, and a third worker then asks which files are acquirable.

| | open after release | still held afterwards |
| --- | --- | --- |
| `upstream/master` | FAILED, 3 of 3 | `demo-journal`, `demo-wal` |
| with the fix | OK, 3 of 3 | none |

The last column is the proof, and it needs no error message: the holder released `demo`, so whatever holds the sidecars is the VFS instance itself.

In wa-sqlite's own suite, `test/vfs_handle_recovery.js` fails on the `default` and `asyncify` builds against `master` with `Error: sqlite3_open_v2`, and the file's 70 tests pass with the fix.

## What this costs us, and what it buys

On our side the fix has a second half, since a retry is still needed once the VFS can recover: `exclusiveFileHandle` in `VFS_CAPABILITIES` — declared, because the error is not available where the decision is made — and `openWithRetry` in `src/worker/worker.ts`, budgeted at 2.5 s on the corpse window. Only `OPFSCoopSyncVFS` and `AccessHandlePoolVFS` take exclusive handles; `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` open theirs `readwrite-unsafe`, where a dead holder blocks nobody.

With both halves, the `OPFSCoopSyncVFS/sync` cell went from three failures to none, 332 of 332.

## Posted upstream

PR [#350][pr350] on 2026-09-18, with the reproduction as a gist and the test in the same branch. It does not claim to make a blocked acquisition succeed — a file held elsewhere is a legitimate failure that the caller is expected to retry. It makes that failure recoverable, which it was not.
