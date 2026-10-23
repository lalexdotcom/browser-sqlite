# wa-sqlite #382 — `OPFSAdaptiveVFS` keeps its lock without a handle after a terminated connection

*2026-10-16 — measured on Firefox 155 (container, Linux) and 157 (GitHub `windows-latest`), Chrome 153 (container) and Safari 26.6.2 (GitHub `macos-26`, `macos-latest`)*

[pr382]: https://github.com/rhashimoto/wa-sqlite/pull/382
[pr381]: https://github.com/rhashimoto/wa-sqlite/pull/381

**Why this is here.** `OPFSAdaptiveVFS` is one of this library's two recommended VFS. Without `readwrite-unsafe` access handles (Firefox, Safari) it hands its one access handle between connections through a Web Lock, the way `OPFSCoopSyncVFS` does everywhere — and a worker terminated while it holds the handle releases the lock at once and the handle only later ([#381][pr381]). This library terminates a worker whose open misses its timeout or whose query is abandoned, and a closed tab terminates its workers too: on Firefox, a second tab on the same database could then hang, or leave the database locked for every other connection.

## How it was found

[#381][pr381]'s body said `OPFSAdaptiveVFS` was being looked into. Read in the code (upstream `6238f532`): `jLock()` sets `isFileLocked`, takes the Web Lock (`handleLockReleaser`), then calls `createSyncAccessHandle()` ONCE with no `try`. A held file makes `jLock()` reject; `libadapters.js` relays an async VFS method through `handleAsync` with no `catch`, so the exception leaves the SQLite call raw — and the connection keeps the lock and `isFileLocked` with `accessHandle` null. `jOpen()` was fine: its `createSyncAccessHandle()` is inside a `try` that releases the open lock and returns `SQLITE_CANTOPEN`.

Then measured with #381's test shape, run for `OPFSAdaptiveVFS`, through the WebDriver harness of the fork's `probe/stock-browsers` (a throwaway `probe/adaptive-held-handle` branch, deleted from the fork since): B opens a database, A opens it and starts a long `count(*)`, B queues a query on the lock, A's worker is terminated directly; 10 rounds per build, B's query bounded at 10 s. A probe variant then had B run a second query and a third connection C open the file and query it, each bounded.

## Measured

On `master`:

| | asyncify | jspi |
|---|---|---|
| Firefox 155, Linux | B hung 4-6 rounds in 10 (4 runs); **C hung each time**: the lock stayed held | B got the raw `NoModificationAllowedError` 5-7 in 10 (3 runs); B's next query `disk I/O error`; **B's `close()` never returned**; C fine |
| Firefox 157, Windows | B hung 7 and 8 in 10, C hung each time | raw error 8 and 10 in 10, same sequel |
| Chrome 153, Linux | 0 in 10 — `readwrite-unsafe`, so `jLock()` is `WebLocksMixin`'s and never hands the handle over | 0 in 10 |
| Safari 26.6.2, macOS (two images, 4 jobs) | no retry possible to count; B "hung" in 1-2 rounds of some jobs, C always fine | no JSPI |

With the change, the same test: Firefox Linux 0 failures in 4 runs (one run's `jspi` half lost to the cascade below; 12 and 5 retries in the two runs that logged them, all `NoModificationAllowedError`), Firefox Windows 0 in 2 runs (17 and 14 retries), Chrome 0, and the whole `OPFSAdaptiveVFS.test.js` 74-76 passed / 0 failed on Firefox and Chrome. The PR branch's own files, run in the harness: Firefox with the change 74/0, Firefox with `master`'s VFS 72/2 (the new test, on both builds), Chrome 74/0.

**Safari does not show the race with this shape**, and the change neither helps nor hurts there: no retry ever fired, with or without it, and its "hung" rounds appear on both arms. It matches HANDOVER-PROBE (`mem:measurements/held-handles`): Safari never terminates a worker spinning in pure WebAssembly, so A is not stopped during its `count(*)` and B simply waits longer than the 10 s bound; once A ends, everything is released together.

## The change

Once `jLock()` holds the lock, a `NoModificationAllowedError` or `InvalidStateError` from `createSyncAccessHandle()` is retried every 10 ms for up to 5 s (#381's bound and constant names). Any other error, or the deadline, gives the lock back (`handleLockReleaser()`, the request listener cleared, `isFileLocked` false), keeps the error in `lastError`, and returns `SQLITE_IOERR_LOCK` instead of throwing. Cost: a file held outside the protocol makes `jLock()` fail after 5 s instead of immediately.

## The test

`test/vfs_terminated_holder.js`, a file of its own, run by `OPFSAdaptiveVFS.test.js` for both builds: #381's test without the probes. In `vfs_handover.js`, where #381 put it for `OPFSCoopSyncVFS`, the "re-prepared statement" test fails on `OPFSAdaptiveVFS` (below), and two PRs editing that file would conflict. The PR says the two can share one helper whichever merges second. It cannot fail on Chrome, so upstream CI (Chrome only) does not exercise it.

## Seen beside it, not part of the PR

`vfs_handover`'s "should not return SQLITE_BUSY from a re-prepared statement", run on `OPFSAdaptiveVFS`, fails now and then on `asyncify` with `database schema has changed` — on Firefox (1 run in 2 on `master`, 1 in 2 with the change) AND on Chrome, where the hand-over code never runs. So it is unrelated to this race. That test was written for `OPFSCoopSyncVFS`'s #347 defect: B creates 100 tables back to back while A re-prepares, and running past SQLite's schema-retry limit may be legitimate for a VFS that releases its lock between re-prepares — not shown. Its cleanup calls `close()` before `finalize()`, which fails, so `destroy()` never runs: its two workers keep the handle and every later test fails its `TestContext.create()` (a 35-failure cascade in one run).

## Posted upstream

PR [#382][pr382], opened 2026-10-16 from `lalexdotcom:opfsadaptive-retry-held-handle`, one commit `d6dd6ba0` on `master` at `6238f532`. The body, validated by the user, carries no measurement: it says the race reproduces in Firefox, most reliably on Windows, explains why Chrome and CI cannot show it and why Safari did not, and has a section on its relation to #381 (same race, same retry; what the race leaves behind and where it shows differ). It does not mention this library.

**Approved by rhashimoto on 2026-10-23** ("LGTM"), who holds the merge until #381's review is addressed, in case a change there applies here too. Neither of #381's two points does — one handle in a `try`/`catch`, nothing else to undo and no `Promise.allSettled` search to type — which we said the same day ([issuecomment-6370214957](https://github.com/rhashimoto/wa-sqlite/pull/382#issuecomment-6370214957)). No change to the branch.

**Merged 2026-10-23** (`010eeb50`, squashed, the file byte for byte our head) and pinned the same night with the repin to `66336807`.

## What stays ours

- **Carried since 2026-10-16.** [`patches/`](../../patches) holds #381's and #382's `src/` hunks, the installed files byte for byte the two PR heads; the library's matrix and Windows run green with them.
- **The rest of the family, surveyed the same day:** no other lock-then-file site of upstream needs a change; the two `OPFSAdaptiveVFS` candidates (a hot journal opened without a lock, an open right after the termination) never failed with #382, on Linux or Windows (ADAPTIVE-382, `mem:measurements/held-handles`).
- The library's `HELD_ELSEWHERE` still matches `NoModificationAllowedError` only (`mem:follow-ups`).
