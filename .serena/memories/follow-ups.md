# Follow-ups — the open backlog

One short entry each, and every entry OPEN. Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## `open-retry` "succeeds once the holder lets go" times out on Firefox — to fix, not to log (user, 2026-09-28)

**The user's priority: reproduce it on demand, then remove the cause, so that CI never fails on valid code.** It has already refused a merge (`test/needs-skip-in-matrix`, first attempt), and five sightings put it past noise. Done means a reproduction that fails on demand — under load, with a squeezed timing, or with an instrumented holder — the cause named, and the fix verified against that reproduction. A raised timeout or a retry of the test is not a fix.

**Sightings, all Firefox, all 30 s with no assertion reached, all an open against a held file:**
- 2026-09-26, the repin's matrix, twice on unrelated cells (`OPFSCoopSyncVFS/async`, `IDBBatchAtomicVFS/jspi`) — never before in seven full matrices. Alone on the same tree: 20 of 20. The repin touches no code the test runs (VFS files byte-identical; only text encoding changed).
- 2026-09-26, the same shape in another test, in the pre-merge hook's `pnpm test` with nothing else running: `pool-cap.test.ts :: … reports the storage error behind a failed open`, `OPFSAdaptiveVFS/jspi`. **A/B of the pins, `pnpm test:firefox` interleaved, 5 runs each: 10 of 10 green**, old and new alike — not attributable to the repin.
- 2026-09-27, once in ten whole-config Firefox passes under sixteen busy loops (REUSE-LOAD).
- 2026-09-28, the pre-merge hook of `test/needs-skip-in-matrix` with nothing else running, `OPFSWriteAheadVFS/sync`. The branch touches no open path and the test declares no `needs`; the same cell had passed in the branch's `pnpm test` and full matrix hours before. Alone on that cell right after: 5 of 5 green; the merge passed on its second attempt.

- 2026-09-28, in the reproduction campaign below: the real test once, `OPFSWriteAheadVFS/sync`, whole Firefox config with nothing else loaded.

- 2026-09-28 evening, not seen: 30 whole Firefox config passes in a row on `main`, nothing else loaded, the stall report in place — 30 of 30 clean (the test ran 60 times, both targets).

**Never on CI.** Green in every CI log since the test landed (2026-09-18); CI has not run since the last push (2026-09-22), and every sighting is later.

**The hang is BEFORE the open under test (2026-09-28).** Both kept logs say `no expect assertions completed`, and the first `expect` is on `holder.take` — so what hangs is `creator.write`, `creator.close` or `holder.take`, never `db.read`/`openWithRetry` (whose 2.5 s budget would throw, not hang). The earlier lead — how long the open retries while the holder is armed — is refuted.

**Not reproducible on demand by volume:** the test's body looped in one page, ~7 000 bounded cycles alone and beside the suite, 0 stalls; instrumented copies of the test (one run per page, its real place) beside the whole Firefox config, 240 runs, 0; the same under sixteen busy loops, 280 runs (copies and the real test), 0. One stall in ~590 real-shaped runs, and load did not raise it. Under load every step stays far inside its budget (`holder.take` p99 463 ms, max 1 005 ms; `creator.write` max 4.2 s).

**Not the Playwright Firefox defects (2026-10-03).** Neither of `firefox-1538`'s worker defects (`mem:follow-ups`, the Playwright entry) explains the stall. The test kills no young worker: its holder is a classic worker ended in `dispose()` after the test, and `creator`'s workers end in `close()` after a write — outside the SIGSEGV window. And the leaked threads cannot reach the 512-worker cap that froze the 2026-09-29 page: in a whole Firefox run every test page gets its own content process, peak 5 threads in one (`mem:measurements`, WORKER-LEAK). The stall's cause is still open; the step it names at the next sighting decides.

**The test now names its stall** (on `main` since 2026-09-28): every await raced against one deadline at 25 s, the failure reading `stalled in <step> … done: <steps before> … holder: <steps reached> … creator: … db: <pool debug state>`. Checked by sabotage — a `getDirectory` that never settles in the holder reports `stalled in holder.take … holder: booted > getDirectory`. **At the next sighting, read the step:**
- `holder.take`, holder last at `getDirectory` — the Firefox engine hang (`getDirectory()` never settles in a worker, the rstest/Firefox silent hang entry). Test-side: the holder must bound its worker and replace it, as the conformance probe does (`6560c9e`).
- `holder.take`, holder last at `createSyncAccessHandle` — Firefox neither grants nor rejects a handle the just-closed client still holds. Test-side: the holder bounds that wait itself.
- `holder.take`, `no step` — the blob worker never booted.
- `creator.write`, a worker `never initialized` — a fresh worker's open never finishes, and nothing in the client bounds a worker's startup (not verified beyond a grep): a consumer would hang the same way. Product-side — instrument the worker's boot next.
- `creator.close` — the drain never ends; the close path.
- `db.read` — the open under test after all; `openWithRetry` and `OPFSCoopSyncVFS`'s lock.

## wa-sqlite #370: MERGED upstream as `7fcc30df` (seen 2026-10-03); repin owed

`IDBBatchAtomicVFS.jDelete` now honours `syncDir` (a `strict` transaction and `sync(true)`), so a journal's deletion commits before SQLite goes on; on master a context ending right after a commit left a hot journal and the next connection rolled the transaction back (the first of a new database, or any larger than the page cache). Report `docs/upstream/2026-10-01-wa-sqlite-370-idb-journal-delete.md`, numbers in `mem:measurements` (IDB-JOURNAL). Branch `fix/idb-journal-delete` on the fork, rebased on `7a4b4241` before opening, CI green; the patch carries its head `57305f73`. Fix A (`sync()` no longer forgetting) stays local on `backup/idb-journal-sync-a`. What each answer calls for:
- **He asks about the cost**: +0.4 ms per journal deletion (first transaction of a new database), none on a batch atomic commit; three-arm table in the report.
- **He prefers fixing `IDBContext.sync()`** (A): it cures termination but leaves the deletion at `default` durability, which SQLite's `extraSync` comment says a power loss can resurrect; offer both together if he wants.
- **He merges**: repin and drop the `IDBBatchAtomicVFS.js` hunk from the patch; the file is then no longer patched.

## wa-sqlite #363: MERGED upstream as `27a6a0b6` (seen 2026-10-03); repin owed

History is in the report (`docs/upstream/2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md`). He accepted the `jUnlock` backstop after our error-path demonstration, would review the `jFileSize` size tracking (the user chose to include it), agreed on clearing the overwrite flag on `PHASETWO`, and asked for the `IDBMirrorVFS` PR.

**Head `345791b3`, pushed 2026-10-03**, made of `0c7ee16d` (the fix), `c9208072` (`test/vfs_publication.js` and its worker) and a merge of upstream `5bde491c`. The file's 120 tests pass 3 of 3 on Chromium and on Firefox; the suite has 6142 passed. Each new test is red on master's VFS, and each fails on a variant missing its part (363-ERROR-PATH, the report's table). Title, description and comment 5966506685 posted.

What each answer calls for:
- **He asks for changes**: in the same worktree (`.work/wa-sqlite-anycontext`); the red arms are rerun by swapping in master's file, the previous head's, or this head without `jUnlock`.
- **He merges**: the repin (deferred by the user) drops the `OPFSAnyContextVFS.js` hunk instead of updating it.
- **Alongside**: the `IDBMirrorVFS` PR, its own entry below.

## wa-sqlite #371: `IDBMirrorVFS` commit-abort — OPENED 2026-10-03, waiting on rhashimoto

Offered on #363; rhashimoto: "Yes, please, if you're up for that." Defect: IDBMIRROR-COMMIT-ABORT; designs compared: IDBMIRROR-ABORT-JOURNAL, IDBMIRROR-ABORT-DESIGNS (`mem:measurements`).

**The user chose the reload design (2026-10-03)** after the measured comparison; the first pushed attempt (poison every call, as `OPFSPermutedVFS`) corrupts the store on reopen and was dropped. **The user asked whether to keep history: no PR was open, so the branch was rebuilt from upstream master `7fcc30df`** (which by then had #363, #369, #370 merged); the old local commits are kept as `backup/idb-mirror-commit-abort-poison`. `fix/idb-mirror-commit-abort` = `1844c761` (fix) + `1f7b2533` (tests), force-pushed over the poison commits on the user's go, then **opened as rhashimoto/wa-sqlite#371**; body opens with "This one turned out trickier than I expected 😅" (user). Report `docs/upstream/2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md`.

What the fix does, each part with a test that fails without it (ablation, both engines): writes never fail (a failing batch write makes SQLite fall back to a journal that is later played back); `#commitTx` refuses a transaction built on an aborted view; a gate request (only while another commit is pending) drops commits queued behind the aborted one, since `abort()` throws after `commit()`; reload from IndexedDB at the next SHARED and in the `full` error path (`#loadFile` extracted from `jOpen`); `SQLITE_BUSY` at RESERVED while aborted (transparent with a busy timeout); the journal removed on `jClose` of an aborted file (else reopen stores the aborted rows, 12/12). Dropped after ablation showed no effect: a second check after `#commitTx`'s await, journal removal on reload, a guard in `#processBroadcasts`. Known limit: exclusive `normal` fails commits until reopen.

Evidence: 6 tests red on master both builds both engines; 190 tests 3/3 on Chromium and Firefox; suite 6274 passed; 168-probe matrix clean; perf = master within variation (9 interleaved runs). The test worker waits for pending commits before closing because closing first throws `InvalidStateError` from the broadcast — a separate defect, on master too, not addressed (a separate PR is possible). **Body corrected 2026-10-03 (user):** the cost sentence now says commits confirmed before the connection learns of the abort are lost only in exclusive mode. **Measured the same day (IDBMIRROR-ABORT-RELOAD-ON-REFUSAL): R3 — reload at the refusal unless a journal exists — lets exclusive `normal` recover after one `IOERR`; not applied, awaiting the user's go (it needs a commit on the branch, a test change and a body update).** Still open: whether to carry it in `patches/` before the merge (user's call), upstream CI green (run 37137339446). What each answer calls for: changes → same worktree `.work/wa-sqlite-mirror-abort`, rerun the falsifiers; merge → repin.

## wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR not decided

Open issue by jwaltz, 2026-09-25, no PR: `OPFSCoopSyncVFS.create()` fails with `NoModificationAllowedError` after a back/forward-cache navigation — the `.ahp-*` sweep in `#initialize()` gets the lock while the cached page's worker still holds its temp handles, and `removeEntry` throws; only `NotFoundError` is tolerated there, since our #347. An immediate retry succeeds; his suggested fix (try/catch around the sweep's `removeEntry`) gave 0/48. The library masks it: `createVfsInstance` retries `create()` on `NoModificationAllowedError`. With the real navigation on Chromium, wa-sqlite alone fails its first open 18 times of 18 and the library's succeeds 18 of 18, ~85 ms later than without a cached page (LEAK-LIB, `mem:measurements`). A PR for #362 was proposed to the user, not decided.

## wa-sqlite: a failed acquisition leaves what was acquired beside it — #350's class in other VFS (2026-09-28)

Found answering rhashimoto's question on #365 ("does OPFSWriteAheadVFS have CoopSync's retry problems?"). Reproduced on upstream `e6e01ae1` with Playwright persistent profiles, 2 runs per case, sabotaged acquisition then reopen; each sketched fix made every case pass. Probes in `.work/worst/leak/`, runners in `.scratchpad/365-lib-arms/` (`reopen-runner.mjs`, `ahp-runner.mjs`, `adaptive-runner.mjs`).

- **`OPFSWriteAheadVFS` `#retryOpen`** opens `-wa0`/`-wa1` with `Promise.all`; `openFile` registers its cleanup only once `createSyncAccessHandle` resolves, so a rejection runs the cleanup before the pending handle lands. `-wa1` stays open and orphaned (5/5, default and asyncify builds). Chromium: reopen works (`readwrite-unsafe` coexists). Firefox: every reopen fails `NoModificationAllowedError`, same worker or another, until the leaking worker terminates. Fix tested: `Promise.allSettled` + rethrow. **Reported on #365 (comment 5874507146), PR offered, no answer yet.**
- **`AccessHandlePoolVFS` `#acquireAccessHandles()`** opens the whole pool with `Promise.all` and nothing cleans up on a rejection. After a failed `create()` (one pool file held elsewhere), every later `create()` fails `NoModificationAllowedError` in any worker until the leaking one terminates, both engines. Fix tested: `allSettled`, then `#releaseAccessHandles()` and rethrow. **In the library:** `createVfsInstance` retries `create()` in the same worker for 10 s, and without the fix every retry fails on the handles the first attempt kept — guarded by `tests/browser/vfs-create-retry.test.ts` (LEAK-LIB, `mem:measurements`). A killed worker does release them one by one on Firefox, within 6 ms (21 under load), and the replacement worker never arrived inside that window (LEAK-LIB).
- **`OPFSAdaptiveVFS` `jOpen`, Firefox only** (the path without `readwrite-unsafe`): it takes the file's Web Lock, then the access handle; if the handle fails, the `catch` returns `SQLITE_CANTOPEN` with the lock still held (`navigator.locks.query()` shows `OPFS:/<file>`) and its `BroadcastChannel` open. Every later open of that file hangs, same worker or another, until the leaking worker terminates. Fix tested: release the lock, close the channel, drop the `mapIdToFile` entry in the `catch`. **No exposure in the library** (LEAK-LIB): a worker whose open fails is terminated, and its lock goes with it.

Not affected: `OPFSWriteAheadVFS`'s temporary files (each closed by a `FinalizationRegistry`), `OPFSPermutedVFS` and `OPFSAnyContextVFS` (one handle per open), `WriteAhead.js`'s `Promise.all` on lock waits, the IndexedDB and memory VFS. **rhashimoto welcomed the PRs (2026-09-28); our reply (comment 5876552104) said they come separately, one per VFS. The three leak PRs are ready, NOT opened — the user decides when (said 2026-09-29: "on verra demain"); the default-build one is #366.** Licence boxes are ticked in the drafts (`mem:conventions`, 2026-09-29). One worktree per PR, off upstream `e6e01ae1`, two commits each (fix, then test), author `my-lalex <lalex@lalex.com>`, pushed to `lalexdotcom/wa-sqlite` on 2026-09-28 with no PR opened; title/body drafts with the licence box unticked in `.scratchpad/upstream-leak-prs/pr-*.md` (the `Title:`/`Branch:` lines are for us, not the body). Each test fails on master and passes 3/3 with its fix; whole suite green on each branch:
  - `fix/writeahead-open-leak` (`.work/wa-sqlite-wa-open-leak`) — **OPENED as rhashimoto/wa-sqlite#367 on 2026-09-29** (report `docs/upstream/2026-09-29-wa-sqlite-367-writeahead-open-leak.md`), after merging `master` in (conflict with #365 in `OPFSWriteAheadVFS.test.js`, both tests kept; re-measured: fails on default, asyncify and jspi on master, 114 tests, suite 5836). `vfs_open_cleanup.js`, a directory named `demo-wa0` makes the first WAL open reject; `Expected 'NoModificationAllowedError' to be 'free'` on master; 5792 passed.
  - `fix/ahp-acquire-leak` (`.work/wa-sqlite-ahp-leak`) — **OPENED as rhashimoto/wa-sqlite#368 on 2026-09-29** (report `docs/upstream/2026-09-29-wa-sqlite-368-ahp-acquire-leak.md`; merges cleanly with master, not re-measured after #365). `vfs_pool_recovery.js` + its worker (a failing `create()` never reaches `TestContext`'s ready message, so own workers); three builds; 5797 passed.
  - `fix/adaptive-open-lock-leak` (`.work/wa-sqlite-adaptive-lock`) — **OPENED as rhashimoto/wa-sqlite#369 on 2026-09-29, MERGED as `d7e7d6b1` (seen 2026-10-03)** (report `docs/upstream/2026-09-29-wa-sqlite-369-adaptive-open-lock.md`; merges cleanly with master and #367). `vfs_open_lock_recovery.js` + worker, which deletes `FileSystemSyncAccessHandle.prototype.mode` before importing the VFS so Chromium takes the no-`readwrite-unsafe` path; reopen bounded at 5 s, `'hung'` on master; 5792 passed. **rhashimoto answered 2026-10-02**: SQLite does call `xClose` after a failed `xOpen` (wa-sqlite's glue sets `pMethods` regardless), so the primary fix belongs in `jClose`, with our `jOpen` change kept in addition. Measured the same day (369-XCLOSE): he is right, and our description's sentence is wrong. A `jClose` that calls `openLockReleaser` fixes the case, as the PR does; no case without an error leaks the lock. A `jClose` must not close the channel unless it also releases the handle lock. **Revised and answered the same day**: `dd5a5c98` (`jClose` releases the open lock, `jOpen`'s comment corrected) plus a merge of upstream `5bde491c` (`71537545`), pushed. Test red on master's VFS and green 3 of 3; suite 6092 passed. Description updated, comment 5960176392 posted, report corrected. Pending: the repin to `5bde491c`. #367 and #368 merged byte-identical, so their hunks leave the patch and #369's hunk takes the new head. Deferred by the user on 2026-10-02: a branch is already open, the repin comes later. **2026-10-03**: asked why `jClose` does not also release the access-handle lock and close the channel. No reason; `87ed5aaf` does it, pushed, green (suite 6092, probe on both engines). Description and comment 5966329411 updated. The repin must take this head.
  - `test/writeahead-default-build` (`.work/wa-sqlite-wa-default-build`) — **OPENED as rhashimoto/wa-sqlite#366 on 2026-09-29** (report `docs/upstream/2026-09-29-wa-sqlite-366-writeahead-default-build.md`). `OPFSWriteAheadVFS` moved to `ALL_BUILDS` in `api.test.js` and `sql.test.js` only (user, 2026-09-28: `OPFSWriteAheadVFS.test.js` gets `'default'` in #365 instead); all pass on the default build; 5965 passed.

  The first and third branches both export `createHolder` from `vfs_handle_recovery.js`, the same one-line change, so they merge in either order. After a PR opens: its report in `docs/upstream/` with its number, per `mem:conventions`. **#367, #368 and #369 are carried in `patches/` since the 2026-09-29 repin** (user). In the library only `AccessHandlePoolVFS` is exposed, and a test guards it; `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` are not (LEAK-LIB).

## Designs owed — ideas, not scheduled work (user, 2026-09-03)

**The user has said explicitly that the three below are not planned for the short or medium
term — they are ideas.** Keep them, do not present them as pending rc.5 scope, and do not
propose them as "the next thing" the way this file's older framing invited.


### A real watcher on a database's clients — deferred by the user, 2026-09-03

Database inspection ships as a one-shot snapshot the consumer polls. The user asked for a
watcher during the brainstorm, then withdrew the word deliberately: *"ce sera une autre
fonctionnalité"*. **The measurement that makes it cheap is already banked** —
`navigator.locks.query()` is `≈ 0.032 ms + 0.00038 ms × n` on Chromium, so polling at
300-500 ms costs 0.14-0.23 ms of main thread per second and takes no lock, no worker round
trip and no queue.

**What it cannot be built on, and this is the whole design constraint:** Web Locks has NO
change notification. An emitter fed from the registry can only poll internally — which
moves the polling under the hood and makes it permanent, charging every client for an
observability most never read. That is why the shipped API is on-demand. A genuine push
mechanism needs a second channel (a `BroadcastChannel` hello/bye reconciled against
`query()` for tabs that were killed without saying goodbye), and that channel is the cost
to weigh, not the query.

**Two smaller emitters may be the better shape than "watch the count"** — the question a
consumer actually has is usually "a tab left" or "the database is free now", and the second
is nearly free already: waiting on `bsq:conn` exclusively IS the event "nobody left".

### One compiled `WebAssembly.Module` for the pool — the premise it waited on is dead

Every worker compiles its own copy of the 1.23 MB binary. Sharing one is verified and
priced in `mem:measurements`: the clone is free and arrives usable, but it buys ~2 ms on
Chromium, which overlaps those compiles anyway, and ~8 ms at the default `poolSize` on
Firefox, which does not.

It was carried on the premise that whatever solved multi-tab would improve those numbers —
a coordinator compiles once per **origin** rather than once per client. **That premise is
gone:** rc.5's cross-tab design has no coordinator and cannot have one, because a
SharedWorker cannot open a connection on the four VFS that matter (`mem:state`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

### A timed flush — out of rc.4 (user, 2026-08-27)

Raised by the user during the back-pressure brainstorm and kept out of the spec, which
records the full argument in its §7. Short form: a timer's memory case is weak — the input
buffer is already bounded at one batch — while its real cost lands on the workload it
targets, since `bulkWrite` commits per batch and a timer on a trickle multiplies commits,
hence OPFS fsyncs, each flush also taking a write lease. What it would buy is latency and
durability: a slow producer's rows reaching SQLite without waiting for `close()`. **The
commit cost the argument turns on is measured**: ~3.4 ms on Chromium/sync and ~5.3 ms on
Chromium/async (`mem:measurements`). That price is what a timer would pay per flush on a
trickle, and it is no longer a deduction.

## `tx.savepoint()` returning a rollback callback — for rc.6 (user, 2026-09-11)

A feature, so rc.6 by the triage rule. Raised while settling rc.5's savepoint rule: three writes
in one `try`, the third times out — rc.5 keeps the first two, as SQLite does for any statement
error. A consumer who wants the three all-or-nothing without abandoning the whole transaction
needs a nested block; the user's shape is a `tx.savepoint()` that returns a callback rolling
back to it. Not designed. It will sit on the savepoint machinery merged on 2026-09-12 (`via`, `__bsq_sp`,
`mem:architecture`): a new entry point must go through the facade, which concludes the library's
savepoint before opening its own.

## The `.mjs` scripts are not type-checked (2026-09-24)

`tsc` covers `scripts/*.ts` since 2026-09-24, but no `allowJs`/`checkJs` is set, so the `.mjs` files are only linted and formatted by biome. Measured with `checkJs` and `@types/node` on 2026-09-24: **84 errors** — `consumer-smoke.mjs` 44, `bench/check.mjs` 19, `bench/dev.mjs` 12, `matrix-triage.mjs` 5, `static-server.mjs` 2, `bench/assemble.mjs` 1, `bounded.mjs` 1. Not triaged: how many are JSDoc-less inference noise and how many real is unknown.

## Playwright's Firefox segfaults on a worker terminated during its first milliseconds — issue to open (user, 2026-10-03)

To report on `microsoft/playwright`, not opened. Playwright 1.62.1's `firefox-1538` (Firefox 153.0, build 20260722045007, linux-aarch64) loses the page's content process to SIGSEGV when a worker is `terminate()`d a few ms after `new Worker(...)`. Terminated at once, or 20 ms and more after creation: no crash. Measured: a plain page creating classic workers two at a time, `await sleep(i % 7)`, `terminate()`, `await sleep(i % 3)`, `terminate()`, 150 iterations — 20/20 driven by Playwright, `blob:` or static script alike, and 6/6 with the binary launched alone; under rstest, the library's own `spawnWorker` (a module worker) on the same schedule — 3/3. Stock Firefox 153.0 (build 20260715202819) on the plain page: 0/20 (numbers and method: `mem:measurements`, LIFECYCLE-SEGV). In a plain page, module workers on that schedule did not crash (0/58), so the window's position depends on the script and how it is served. Not established: Playwright's patches or a Firefox change between the two build dates — before opening, check a newer Playwright's Firefox, and a later stock build. The reproduction is one HTML file with that loop. The same build also leaks `DOM Worker` threads past `terminate()` — 17 for 300 workers in the library's gate sequence, 43 for 80 workers never terminated whose iframe is removed — where stock Firefox leaks none (`mem:measurements`, WORKER-LEAK); worth the same issue.

`lifecycle.test.ts`'s silent workers wait for a boot signal before they are killed, which keeps those two tests out of that window; the rest of the file, amplified the same way, never crashed (0/10), and no other test file was found in the window (`mem:measurements`, LIFECYCLE-SEGV).

## The rstest/Firefox silent hang — CAUSE FOUND 2026-09-16, fix not taken

**`navigator.storage.getDirectory()` inside a dedicated worker sometimes never settles on Firefox
— no resolve, no reject — under concurrent OPFS access from many pages.** That call sits at
module scope behind a TOP-LEVEL AWAIT: `probeUnsafeHandles()` in `tests/conformance/helpers.ts`,
reached by every browser test file through `tests/browser/helpers.ts` → `AVAILABLE_FEATURES`.
rstest runs test files in parallel pages, so ~43 of these probe workers start per run, ten of them
inside one five-second window. When one never answers, that file's module never finishes
evaluating: **no test starts, so neither `testTimeout` (30 s) nor `hookTimeout` can fire**, rstest
reports the file as "running" for ever, and `pnpm test` never ends.

Established 2026-09-16, by instrumenting the probe worker step by step and catching a wedge:
the wedged page prints `worker constructed` then `step:start` and nothing more, where a healthy
page goes `step:start → got-root → got-file-handle → h1 → caught(NoModificationAllowedError) →
ANSWERED false`. It stops at `await navigator.storage.getDirectory()`.

Arms, all on Firefox `OPFSWriteAheadVFS/sync`, one project, no load: real probe **4 hangs / 24
runs** (~17 %); probe stubbed to `return false` (behaviour-neutral on Firefox) **0 / 9**; probe
bounded at 8 s **0 / 6**. The hang lands on whichever file loses: `inspect-marker` ×3,
`inspect-client` ×1, `pool-savepoint` ×1.

REFUTED on the way, keep refuted: it is NOT contention on the probe's fixed file name. Measured
directly — a second `createSyncAccessHandle` on a held file REJECTS at once on Firefox
(`NoModificationAllowedError`) and is granted on Chromium (that is what the probe reads).

**Guarded 2026-09-16 (`6560c9e`), not cured.** Each probe attempt is bounded at 10 s, a wedged
worker is terminated and replaced, three times, and the third failure THROWS rather than answering
— a silent `false` would flip `readwrite-unsafe` on Chromium and make tests pass for the wrong
reason. `scripts/bounded.mjs` now gives every browser script a deadline (exit 124), because the
next hang of this shape will not be this one.

WHAT REMAINS OPEN:
- **`HAS_UNSAFE_HANDLES` is still awaited at module scope** (`tests/conformance/helpers.ts`, the
  top-level await; `AVAILABLE_FEATURES` is only derived from it — this entry used to name the wrong
  one). **Making it lazy is NOT the structural answer this entry once claimed, and the correction
  is measured (2026-09-21):** it would not reduce the number of probes, which is what wakes the
  engine bug. `readwrite-unsafe` feeds `singleConnectionWithout` and `exclusiveConnectionWithout`
  (`src/const/vfs.ts`), so `pairFor()` needs the answer in every browser test — on demand or at load,
  every page still probes once. And the run no longer hangs either way, since `6560c9e` bounds it.
  What laziness would still buy is only that a module-scope throw becomes a named test failure.
- **The lever that WOULD attack the trigger is one probe per run instead of one per page**, and it
  is now designed rather than speculated. Measured 2026-09-21, all three:
  rstest 0.11.8 has **no per-run hook with browser access** (`setupFiles` runs before each FILE;
  `globalSetup` runs in Node, and beside `projects` at root level it is silently IGNORED — declared
  per project it runs once per project); the **injection channel works** — a value set in
  `globalSetup`'s `process.env` reaches the page as `import.meta.env.X`, synchronously at module
  scope, so declaration-time skips survive; and **no storage is shared** to cache an answer in —
  not across runs, not across files of one run (same origin, isolated: `a` reads back its own
  write, `b` reads `<empty>` 4 s later), not across projects (the origin's port differs). So the
  shape is: `globalSetup` launches its own Playwright browser against a `127.0.0.1` page, probes
  once, injects. Cost measured at **813 ms per project** (launch 183, page 404, probe 45, teardown
  175) — ≈ +3.3 s on `pnpm test`, ≈ +2 % on the matrix, against 45 ms per page removed in parallel.
  Roughly neutral in wall clock: the cost is not the argument either way.
- **The engine bug is unreported, and Bugzilla was searched on 2026-09-21: nothing matches.** The
  component is **Core › Storage: Bucket File System** (where the OPFS meta 1748667 lives); its 33
  open bugs are almost all the `readwrite-unsafe` series and PBM, and a summary search for
  `getDirectory` and `hang` there returns nothing of this shape. `Storage: Quota Manager`'s hangs
  are all shutdownhangs.
  **Two things block the report, and neither is the writing.** (1) The repro is not portable: the
  console probe — 12 same-origin iframes × 4 workers, 3 rounds released together, each worker walking
  `getDirectory` → `getFileHandle` → two sync access handles, bounded — does NOT reproduce it (0 of 144;
  48 workers from one page, 0 either), only
  the suite's shape does — ~50 pages each asking a worker for the OPFS root within a few seconds.
  (2) Every sighting is on **Playwright's Firefox 153.0** (BuildID 20260722045007), a patched
  build; Mozilla will ask first, so confirm on a stock Firefox before opening, or the bug is
  Playwright's, not theirs. Then: `enter_bug.cgi?product=Core&component=Storage%3A%20Bucket%20File%20System`,
  blocks 1748667, keyword `hang`, and a `mozregression` range if it reproduces on stock.

## The consumer docs are hard-wrapped at 80 columns (2026-09-18)

`VFS.md` ~23 wrapped prose paragraphs, `README.md` ~9, `API.md` ~3; `CHANGELOG.md` is clean. The
user's rule is long lines in markdown (`mem:conventions`, writing for the consumer) — hard wrapping
makes a reworded sentence reflow a whole block and hurts reading in rendered form. **`VFS.md` cannot
be fixed in the file alone**: 14 of its spans are generated, and the wrapped strings live in
`scripts/render-vfs-matrix.ts`; the `pre-push` hook runs `pnpm docs:vfs && git diff --exit-code
VFS.md` and would reject a divergence. Pure formatting, no behaviour, but it touches three consumer
files plus a script.

## What the matrix showed, and what it shows now (2026-09-16, resolved 2026-09-18)

**The three product defects are gone.** Full matrix on 2026-09-18 after the fixes: 65 of 66 cells
green, 1 failing test, 1 distinct group — against 62 cell-failures and 20 groups on 2026-09-16.
**Re-measured 2026-09-21 once that one was fixed (`2be2ae6`): 66 of 66 cells green, 0 failing
tests, 2650 s.** Every one of the three traced to a
wa-sqlite defect rather than to this library, and each is upstream with a falsifying test in
wa-sqlite's own suite: `OPFSCoopSyncVFS` → #350 plus our own `deleteDatabase` probe (a file's
existence, not an open), `IDBBatchAtomicVFS` → #351, `IDBMirrorVFS` → #352 and #353. Reports in
`docs/upstream/`, patch inventory in `mem:stack-and-build`.

Kept for its method rather than its content — the original entry, now closed:

Numbers in `mem:measurements`. `scripts/matrix-triage.mjs` regenerates the grouping from any
`.matrix/<run>/`.

**Everything the triage called test work is done.** 989 cell-failures → 500 (the dead cleanup)
→ 79 (the `Need` vocabulary and the pinned pool sizes) → pending, after the dying-worker handle
fix cleared the last 18. `MemoryVFS` and `MemoryAsyncVFS` are entirely green; 49 of 66 cells were
green before the last fix. **The lesson the sequence taught, and it was the triage's own
prediction: clearing the first pile is what made the second readable** — the second GREW when the
first went, because tests finally reached their real cause.

What is left is product, on three VFS, none of them recommended. Each needs a diagnosis before a
fix, as `output()` did.

- **`IDBMirrorVFS` — 46.** All one defect, and the abandonment was never the cause: `pData` is a
  `Uint8ArrayProxy`, so `block.set(pData, …)` stored zeroes — including over SQLite's rollback
  journal header, after which a rollback undid nothing.
- **`IDBBatchAtomicVFS` — 8.** One defect too, with two faces by build: `jWrite` wrote through a
  block it assumed started at the offset.
- **`OPFSCoopSyncVFS` — 7.** Two unrelated causes, which nothing suggested: the six
  `DATABASE_NOT_FOUND` were `deleteDatabase` reading `SQLITE_CANTOPEN` as absence on a database
  that existed but was empty; the `sqlite3_open_v2` ones were handles leaked by a partial
  acquisition.

**The lesson the three shared, and it is in `mem:lessons`: a pile's twelve subjects can be one
defect, and the scenario a defect is found through is often not the one that demonstrates it.**

## Two worker fallback messages carry the path (2026-09-23)

`src/worker/worker.ts`'s open and delete fallbacks read `Failed to open ${file}` / `Failed to delete ${data.file}`, and since `feat/vfs-folders` the worker only knows the path (`.ad/name`). They fire only when something that is not an `Error` is thrown, and `startupError` forwards the text verbatim, so no client wrapping re-adds the logical name. Parked by the controller's ruling: the path is the only identifier the worker has. Reattaching the logical name would mean sending it to the worker or wrapping on the client side.

## Smaller things this branch left open (2026-09-15)

- **`handleDeath`'s guard for a slot-0 loss before the probe has no test** — no path was found that reaches
  it with the probe unanswered; it is defensive (`a0373c0`).


## Three browser tests guard less than their comments said (2026-09-14)

Found by `fix/pool-environment-cap`'s Task 10 and its reviews:

- **`barrier.test.ts` does not guard the barrier — because nothing observable does (spike, 2026-09-25).**
  Deleting the barrier statement leaves all six tests green on every declared pair, Chromium and
  Firefox (44 cells), with a positive control proving the path is reached. Bisected in a worktree
  holding today's `node_modules`: the two single-client tests went inert at `8bc0bf1` (last-writer
  routing sends the read to the fresh writer), the two-client ones at `aee3859` (statement cache).
  **`aee3859` is the real cause:** it moved `sqlite.column_names(stmt)` after the first `step()`.
  The old worker read the names BEFORE stepping, so a statement prepared on the old schema and
  re-prepared by SQLite at `step()` returned fresh rows under stale names — exactly the spec's
  `{"old_col": 42}`. Reverse-mutated on today's code (names read before the step): all seven
  schema scenarios go red without the barrier, and most stay red WITH it, since a cached statement
  keeps its old prepare. **So the staleness the barrier was built for was our worker, not SQLite;
  the tests are regression tests of the column-name capture, which is their real falsifier.**
  **Data staleness, probed the same day (BARRIER-DATA, `mem:measurements`): 3 stale reads in 1232
  without the barrier, 0 in 1232 with it, under incidental load; 0 / 480 in a focused loop, idle
  and loaded, in both arms.** So the barrier may guard something rare and nothing reproduces it on
  demand: it stays, and it still has no falsifier. Cross-tab needs no probe of its own — without
  the barrier there is no shared state left, and two tabs are two clients' workers to SQLite. The
  next step, if anyone chases it, is a reproduction of the three sightings' conditions (a loaded
  full run of the data probe), not a longer loop.
  **That reproduction was run on 2026-09-27 and it reproduces** (BARRIER-DATA, `mem:measurements`):
  under sixteen busy loops, 37 of 616 tests stale without the barrier, 0 of 616 with it, on the same
  cells — all on Chromium, every scenario, growth included. The barrier guards data freshness for
  real. **Cause found the same day (BARRIER-DATA): `OPFSWriteAheadVFS`'s read isolation.** A read
  transaction freezes the connection's view as the `BroadcastChannel` has left it, without reading
  the write-ahead to current as a write does; under load the writer's `tx` message is processed
  after the next read starts. 28/100 stale as shipped, 0/100 with `isolateForRead()` reading to
  current, 9/100 on the pre-#355 code. The barrier only buys time. **The race is traced** (BARRIER-DATA):
  the `tx` broadcast and the read's `query` take two channels with no ordering between them, and
  the stale reads are the ones where the query arrives first — present before #355, which only
  widens it. **Submitted upstream as rhashimoto/wa-sqlite#365 on 2026-09-27** (report
  `docs/upstream/2026-09-27-wa-sqlite-365-writeahead-read-freshness.md`); its fork branch
  `fix/writeahead-read-catches-up` was deleted after the merge, remote and local, 2026-09-29
  (first commit `1273bb48` on upstream `e6e01ae1`): `isolateForRead()` reads the WAL to its end. Its test, in wa-sqlite's own suite,
  is deterministic — a reader worker blocks its event loop while a writer worker commits, then
  reads before its context delivers the broadcast: `1` for `2` on master, 8/8 runs, both builds.
  Two connections in ONE context share a `WriteAhead` view and cannot reproduce it. Cost ≈ 5 µs
  per read transaction on asyncify. **Carried in
  `patches/` since 2026-09-27.** **2026-09-28: answered "by design", now opt-in, and the library
  sets it in the barrier.** rhashimoto keeps reads eventually consistent on purpose: reading to
  the end scans the uncommitted frames of a large open write on every read (~2 ms per MB,
  365-WORST, `mem:measurements`). The PR's second commit `ac817fd6` makes it an
  opt-in pragma, off by default; review renamed it `PRAGMA wal_read_latest` (third commit
  `7d16633b`, 2026-09-28), and the patch carries that head. Our barrier on
  `OPFSWriteAheadVFS` runs its read between `wal_read_latest=1` and `=0` (`catchUpPragma`,
  `barrierSqlFor`), so the reads after a commit are current by construction and reads during a
  large open write scan nothing (365-LIB). **What is still open:** the barrier has no falsifier
  that fails under load — the old timing-only barrier read 0/100 even under 48 busy loops, so
  the pragma's gain is shown by wa-sqlite's deterministic test, not by ours. **#365 was MERGED on 2026-09-29 as `5be9cd14`, byte-identical to our PR head `7d16633b`**
  (`PRAGMA wal_read_latest`, the default build in `OPFSWriteAheadVFS.test.js`). The pin is on
  `5be9cd14` since 2026-09-29 and the patch no longer carries it (`mem:stack-and-build`).
- **rstest's pages are off-the-record: OPFS sync-access-handle calls cost 160-290 µs there against
  0.6-2.6 µs on a persistent profile (RSTEST-OTR, `mem:measurements`, 2026-09-28).** rstest opens
  pages with Playwright's `browser.newContext()`. Every absolute OPFS timing taken under rstest —
  the checkpoint and page-size campaigns included — carries that per-call cost; ratios between
  arms of one run still compare. Not acted on: whether to measure OPFS in a persistent context
  (wa-sqlite's runner, or a Playwright `launchPersistentContext` harness) is the user's call.
- **`OPFSAnyContextVFS` releases its lock with a truncation still invisible — `disk I/O error` on
  Firefox (2026-09-25). FIXED in our build by a `patches/` hunk, submitted upstream as
  rhashimoto/wa-sqlite#363** (report `docs/upstream/2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md`).
  When it merges: repin and drop the hunk, per `mem:stack-and-build`. Guarded here by `tests/browser/vacuum.test.ts` (need
  `in-place-file`, added for it); upstream by `test/vfs_xUnlock.js` (8192 for 4096 on master). Full
  matrix with the patch, 2026-09-25: 66/66 cells green. Seen as `VACUUM` + two concurrent reads failing
  in one client with two workers; on Firefox `needs: ['two-workers']` resolves to
  `OPFSAnyContextVFS` whatever the target, 8-12 of 20 per run, never on Chromium (20/20 on the same
  pair). The failing statement is the READ on the other worker, `SQLITE_IOERR_READ` (266).
  **A `BroadcastChannel` trace of the VFS shows the mechanism:** `jTruncate` opens a writable and
  leaves it open; SQLite calls no `xSync` after the post-commit truncation, so the writer unlocks
  with the truncation unpublished. The reader takes `SHARED`, `getFile()` returns the OLD file
  (2 232 320 bytes against 8192), the writer then closes its writable for its own next read, and
  the reader's `File` snapshot dies with `AbortError`. **Hypothesis tested:** closing a pending
  writable in a `jUnlock` override, before `super.jUnlock`, gives 60/60 on Firefox (jspi and async)
  and 20/20 on Chromium. Upstream master (`e98c65d`, our pin) has no such close; upstream issues not
  searched yet (`gh` is available since 2026-09-28). Same shape as #361: an upstream PR plus a `patches/` carry.
  Also worth knowing: in that window a
  reader could read the pre-truncation file rather than fail, if its read wins the race.
- **The open-side init lock guards nothing a test sees (2026-09-28).** With `locks.withLock(initLockName…)` removed from the worker's `open()`, `pnpm test`'s three configs stay green; the delete side is guarded (`delete.test.ts`, BUSY while the lock is held). What it seemed to guard — a writing pragma at open against another client's write — was a defect of its own, fixed by running those pragmas through the write path (PRAGMA-BUSY, `mem:vfs`); since then the open applies only connection pragmas, and the lock serialises opens with nothing left to protect that a test has found.

## What the `IDBBatchAtomicVFS` long-statement fix left open (2026-09-14)

- **On Safari, wa-sqlite's `async` (Asyncify) build slows down after a few long statements, and
  stays slow.** Measured 2026-09-14 on Safari 26.6.2 (IDB-SIGNAL, `mem:measurements`): after four
  ~1.5 s reads, `IDBBatchAtomicVFS` and `OPFSAnyContextVFS` ran their fourth at 11-30 s, and every
  `async` column's cached full scan ran 8-17× slower afterwards; `MemoryVFS` on the `sync` build did
  not move. Not IndexedDB (a 32 MB cache changes nothing), not the library's yield (no signal in the
  probe, and rc.4 shows it). Pre-existing; Chromium and Firefox never showed it. **The `jspi`
  build escapes it** (Safari 27.0, flat long reads and a cached scan back at baseline), and on
  that Safari the bench's two `jspi` columns answer `true` where both `async` ones stay `null`.
  Since 2026-09-24 an omitted `build` loads `jspi` wherever the engine has it, so Safari 27+ escapes
  it by default; `VFS.md`'s `async` note says so. Still open: an upstream report (wa-sqlite or WebKit).

## wa-sqlite's `OPFSAdaptiveVFS.js` reads `FileSystemSyncAccessHandle.prototype` at module load (2026-09-14)

Line 9, unguarded, and it is bundled into the one worker file, so where the interface is missing no
VFS loads at all, memory VFS included: Playwright's Linux WebKit 26.5 failed every column's `opens`
with `TypeError: undefined is not an object (evaluating
'globalThis.FileSystemSyncAccessHandle.prototype')`. Safari on macOS has the interface, and
Playwright's Linux WebKit was set aside earlier for limits of this kind (user). Unmeasured whether
a consumer environment lacks it; an insecure context is the candidate. Pre-existing, not scheduled.

## Notes, with nothing to fix

### `page_size` on `OPFSWriteAheadVFS` — not pursued, closed by the user on 2026-09-28

32 KiB pages made a bulk insert 3.25× faster on Chromium and 1.18× on Firefox (PAGE-SIZE, `mem:measurements`), but only that workload was measured. The user set the lever aside: no advice in the docs, no follow-up.

### wa-sqlite's `autoCheckpoint` treats any positive value as "after every transaction" — deliberate, closed by the user on 2026-09-28

`#autoCheckpoint()` (`WriteAhead.js`) tests `autoCheckpoint > 0` only. The author says so explicitly in a comment; the user keeps it that way. Do not propose it upstream again.

### #361's executor allocates per read and per write, not once per checkpoint — declined upstream, closed by the user on 2026-09-28

The single allocation was suggested in the reply to rhashimoto's review (2026-09-26). His answer: "Not necessary as far as I'm concerned. I don't care so much about achieving a strict memory cap, only that there is a way to tune memory usage up or down if needed" — which `checkpointBufferSize` gives. In the same comment he declined a tighter planner (unretired reads kept across writes) on complexity: "It can be a lot more complicated but it can't get that much faster." #361 merged without either. The user holds to his call.

### `pool-cap`'s surplus-slot flake — margin widened, never reproduced; closed by the user on 2026-09-27

**The test.** `tests/browser/pool-cap.test.ts :: a pool capped by its environment > a surplus slot that times out, then declines in the retry round, is not announced lost` — Firefox only (`CAPPED`, no `readwrite-unsafe`). It holds slot 1's round-1 `open` back so round 1 gives up on it, then lets the retry decline, and asserts no `onWorkerLost`, a pool of 1, no warning.

**The flake and its mechanism.** Seen under load as `Worker 1 did not become ready within 600 ms`: `openTimeout` is client-wide, so it also governs slot 0's HEALTHY worker, and it was that one that missed. Squeezed on an idle machine, slot 0 needs some tens of ms (10, 25, 50 ms fail; 100 ms passes). `2be2ae6` (2026-09-21) moved `openTimeout` 600 → 3000 (~10× → ~50×) and the held-back `open` 3000 → 15000.

**Why it is closed although the cure is not demonstrated.** The flake was never reproduced, before or after — 64 busy loops left both budgets green — and on 2026-09-27 it ran in all ten whole-config Firefox passes under sixteen busy loops without failing (REUSE-LOAD, `mem:measurements`).

**If it is seen again:**
- Keep the whole run log and note the engine and the message — `did not become ready` means slot 0 missed the shared budget again.
- **Do not scale the numbers a third time.** The next move is a budget of slot 0's own, which is a product change: `openTimeout` is one option for the whole client.

### `WORKER_BUSY` seen once on 2026-09-14, never reproduced — closed by the user on 2026-09-27

**The sighting.** `query-timeout.test.ts :: rejects with OPERATION_TIMEOUT and leaves the client usable` failed once in a pre-push `pnpm test` on a loaded machine, with "Worker 1 already has a query in flight" — the reuse guard, now `WORKER_BUSY` (`src/pool.ts`). The log was not kept. That test then ran on `MemoryVFS`'s default `sync` build, which cannot cut a statement without isolation, so the timed-out query kept its worker for its whole natural length (22 s on Firefox, 60 s loaded) while the follow-up read raced it; it has run on `async` with that read bounded since 2026-09-15 (CI-QUERY-TIMEOUT).

**Chased twice, in both contexts, 0 each** — one file under sixteen busy loops, 0 of 40, with a positive control proving the detection path (LEASE-QUIESCE, 2026-09-21); the whole Firefox config ten times under sixteen busy loops, 0 in 7 453 tests (REUSE-LOAD, 2026-09-27). Both in `mem:measurements`.

**If it is seen again:**
- **Keep the whole `pnpm test` log** and note the engine, the target project and the test.
- It was at the CLIENT level (`db.read` through the scheduler), so the transaction queue does not explain it. With transactions serialised the guard means one thing only: **the scheduler handed a lease for a worker that was not idle** — that is the sentence to test, starting from where the lease is returned (`quiesce()` in `onReadLease` and `streamWithRetry`, `src/client.ts`).
- Before trusting a reproduction, check it aborts the statement it names: a wait on "a worker is running" once let aborts land on the freshness barrier (`mem:lessons`, 2026-09-27).

### An abort through the shared slot reports `done`, not `error` — and that is right

The worker breaks out of its row loop rather than throwing, so the query ends with `done` and
the pool's `onServed` fires exactly as for a completed query. That looks like a
misclassification and is not one: `onServed`'s only effect is `slot.restarts = 0` in
`src/supervisor.ts`, and it means "this worker executed SQL and came back", which an
interrupted worker has just demonstrated. Withholding it would make the supervisor readier to
condemn a healthy worker. Raised by the final review of the query-interruption lot,
2026-09-05, and deliberately not changed.

### Twelve `any` remain in `src/`, and they are structural

The return type of the dynamic VFS and WASM imports inside their `satisfies`
constraints; the VFS instance, which upstream does not type (it declares only
`examples/tag.js`); `bulk.ts`'s `{ [K in KEYS]: any }` row shape, where `unknown`
breaks the `keys.map((k) => data[k])` indexing; and one overload dispatch in
`locks.ts`. Thirty-seven became twelve on 2026-08-31 and the remainder is not
worth chasing. **Re-count before citing this.**

**Kept deliberately, do not "clean up":** the no-op degradation branch in
`locks.ts`, unreachable in Node ≥ 21 and every current browser. Spec-mandated,
correct, zero maintenance.


### The library's floor is computed, not transcribed (2026-08-28)

`LIB_FLOOR` in `scripts/render-vfs-matrix.ts` is read from
`@mdn/browser-compat-data` (a devDependency) over a named list of the APIs the
published bundle uses, mobile columns from `chrome_android` / `safari_ios`
rather than inherited from desktop. The computed floors reproduced the
transcribed ones byte for byte, so the old numbers were right — they simply
could not stay right on their own. `bcdVersion` throws rather than guessing when
BCD gives `true` or `false` instead of a version.

**`FEATURE_SUPPORT`, right above it, is still transcribed by hand and cannot be
fully mechanised**: JSPI's `Safari: '27'` comes from a WebKit blog post, not from
BCD. Its "checked 2026-08-24" comment is load-bearing; do not delete it under the
impression that the file now reads everything from BCD.

**`structuredClone` was the trap.** It would have raised the floor from Chrome 92
to 98 — for an error *cause*. `cloneable()` now probes with `MessageChannel`
(Chrome 2, Firefox 41, Safari 5), which runs the same algorithm and throws the
same `DataCloneError`. The probe exists because a cause that cannot be cloned
makes `postMessage` throw *inside a catch block*, so the client receives no reply
at all and waits for ever. It lives in `src/worker/cloneable.ts` — pure, and
tested in Node, for the reason `statement-cache.ts` is.

**Decided 2026-08-25: do not support below the floor.** OPFS itself is Chrome
86+, so a pre-86 engine cannot run the six OPFS VFS at all. What was built
instead is a classic ES5 script ahead of the module in the bench page that
watches for the module having started and, after 8 s, replaces the banner with
what is missing. It tests for the module *running*, not for syntax, so it also
covers a failed `dist/` fetch. Falsified by blocking that fetch, not reasoned
about.

One case is deliberately **not** folded to `MAX(vfs, lib)`: where a source says
supported but gives no first version, the cell keeps `?` rather than adopting the
library's number — the true floor is at least that and may be higher.

### BENCH-DRIFT — the page holds a second copy of the invariants, permanently

The six conformance invariants are duplicated between `scripts/bench/html/index.html` and
`tests/conformance/`, ~220 lines each side. `dist/index.js` is the page's only import
channel, so sharing them would ship conformance assertions to every consumer.
`HAS_UNSAFE_HANDLES` stays on the page because it needs a worker and two access handles.

**The live rule: changing either copy obliges a review of the other, both directions.** The
page's row ids are normalized from the conformance `describe()` titles, so a row whose id
no longer maps to a `describe()` is the signal. Two places where the copies legitimately
differ and must **not** be aligned: the page returns `'blocked'` where invariant 6 logs a
`console.warn` and passes (a table has somewhere to render a third state, a suite does
not); and the page reopens the column's client after `survives-reopen` and `close-settles`,
because it runs every row against one client where the suite gets a fresh one per `it()`.

## What no test can see about the statement cache

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".
