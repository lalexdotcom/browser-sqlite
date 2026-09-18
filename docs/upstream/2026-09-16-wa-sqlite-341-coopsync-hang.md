# wa-sqlite #341 — `OPFSCoopSyncVFS` hangs on a fresh file, and PR #347 fixes it

*2026-09-16 — 164 four-connection runs across two engines and three source trees*

**Why this is here.** [browser-sqlite](../../README.md) carries a patch to
`OPFSCoopSyncVFS` ([`patches/wa-sqlite@1.1.2.patch`](../../patches)) that is
upstream as [rhashimoto/wa-sqlite#347][pr347]. Reading the open issues,
[#341][i341] — four connections migrating the same fresh OPFS file hang forever
— looked like the same defect seen from the other end. It is. This file records
what was measured, because the measurement is what the upstream maintainer had
been waiting a month for.

[pr347]: https://github.com/rhashimoto/wa-sqlite/pull/347
[i341]: https://github.com/rhashimoto/wa-sqlite/issues/341

## The reproduction published in #341 could not work

Its workers use top-level await (`await SQLiteESMFactory(...)`) and the page
posts their task at construction. **A message posted before a module worker has
finished evaluating is dropped, not queued** — measured on Chromium 151.0.7922.34
and Firefox 153. The worker reaches its `self.onmessage` assignment and nothing
is ever delivered:

```
worker-top → imports-done → factory-done → vfs-ready → handler-installed
                             (the page's message was posted before this, and is gone)
```

So every run reports `HANG:0` whatever the VFS does. The symptom is
indistinguishable from a deadlock: nothing settles, no error, no `onerror`.
[`repro/module-worker-handshake-probe.mjs`](repro/module-worker-handshake-probe.mjs)
is the probe that isolates it, and it applies to any worker harness in this
repo: have the worker announce itself and send work only in reply.

## What was measured

[`repro/repro-341.mjs`](repro/repro-341.mjs) — self-contained, run from the root
of a wa-sqlite checkout (`dist/` is committed upstream, so nothing is built).
Four module workers, one fresh OPFS file per run, each `open_v2` +
`CREATE TABLE IF NOT EXISTS` + a 200-row transaction. Chromium 151 via
Playwright 1.62.1, a fresh browser context per run, hang deadline 12 s against a
~130 ms clean run.

Trees came from `git archive` of the upstream remote, so only
`src/examples/OPFSCoopSyncVFS.js` differs between them.

| tree | engine | runs | hung | all four succeeded | settled with `database is locked` |
| --- | --- | ---: | ---: | ---: | ---: |
| `master` (07ad48c) | chromium | 30 | **19** | 5 | 10 |
| `master` + #347 | chromium | 30 | **0** | 30 | 0 |
| `master` | chromium | 44 | 19 | 6 | 19 |
| `master` + #347 | chromium | 40 | 0 | 40 | 0 |
| `master` + the `jUnlock` commit only | chromium | 30 | 0 | 30 | 0 |
| `master` | firefox | 10 | 1 | 9 | 0 |
| `master` + #347 | firefox | 10 | 0 | 10 | 0 |

The first two rows are the standalone script above; the rest is our own harness.
A single connection settles in 110 ms, always.

Two readings beyond the hang. The `jUnlock` commit alone accounts for the whole
fix — the `#initialize` `NotFoundError` commit in the same PR is unrelated to
this issue. And on master only 5-6 runs in 30-44 had all four connections
succeed: the rest handed `database is locked` to the application on a *fresh*
file, where serialising would have been correct. With the patch, every
connection in every run succeeded and no `SQLITE_BUSY` reached the caller.

## The poisoned lock file did not reproduce

#341 reports a second symptom: after the hang the lock file is left poisoned and
no later connection can open the database. After each of the 19 hangs the script
closes the page — terminating the hung workers and releasing their access
handles — then runs the same full workload with one fresh connection, on the
same file, in the same browser context. It succeeded 19 times out of 19.

Untested: persistence across a browser restart in a persistent profile
(`launchPersistentContext`), since every run here uses an ephemeral context. The
plausible reading is that what looked like a poisoned lock file was the deadlock
itself seen from a new connection, with the hung workers still alive and still
holding the handle.

## What deadlocks

From a `vfs.log` trace of a hang (`t` in ms since worker start; w2 and w3 are
the connections that never return):

```
55 w1 jLock / lock requested / returning SQLITE_BUSY / jUnlock
56 w1 threw "database is locked"      <- the application gave up; w1 is idle
56 w1 received notification           <- its channel handler fires once, then
                                         sets onmessage = null
68 w1 lock acquired                   <- the request queued at t=55 wins the Web
68 w1 creating access handles            Lock, for an idle connection
   (w1 never calls jUnlock again, and no longer listens)
1064 .. 11063  w2, w3: notifying … notifying … notifying   (every 1000 ms, forever)
```

Three things compound:

1. `jLock()` sets `isFileLocked = true` *before* the `SQLITE_BUSY` return, and
   `jUnlock()` deliberately changes no state when `isLockBusy` — so a connection
   whose call ends on a BUSY keeps `isFileLocked === true` indefinitely.
2. `handleRequestChannel.onmessage` sets itself to `null` after one
   notification. With `isFileLocked` stale-true it only records
   `isHandleRequested = true` and defers the release to a `jUnlock()` that never
   comes — and it is now deaf to every later notification.
3. The `#requestAccessHandle()` queued by that failed `jLock()` still runs to
   completion: it takes the Web Lock and creates access handles *for a
   connection that has nothing left to do*. Everyone else waits on that Web Lock
   forever.

Our patch breaks the chain at its start. Upstream releases the handle at the
inner `jUnlock(NONE)` of a call that is not over; the relock inside the same
call returns `SQLITE_BUSY`, `retry()` has already spent its two attempts, and
the caller gets `database is locked` — which is exactly the idle connection with
a queued handle request of step 3. Deferring the hand-over to the end of the
call means the call completes: no spurious BUSY, no orphaned handle request.

**It removes the trigger, not the fragility.** Points 1-3 remain true with the
patch applied. Any other route that leaves a connection idle after a
`SQLITE_BUSY` can strand the access handle the same way, and a holder still
listens for exactly one notification. Left to the upstream maintainer to decide.

## Posted upstream

Both on 2026-09-16: a comment on [#341][i341] carrying the reproduction, the
numbers and the trace, and a section added to the [#347][pr347] description
ending in `Fixes #341` — with the qualification that only the hang half is
measured.
