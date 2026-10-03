# Follow-ups — the open backlog

One short entry each, and every entry OPEN. **An entry marked DORMANT waits for an event and needs no action until it comes: it is not part of the backlog and is not listed when the user asks for it (user, 2026-10-03).** Anything closed is deleted from here —
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

## `open-retry` "succeeds once the holder lets go" times out on Firefox — DORMANT until the next sighting (user, 2026-10-03)

**DORMANT: no action until it happens again (user, 2026-10-03).** Reproduction attempts are over (below), and nothing since the test names its stall: 13 full matrices of 22 Firefox cells each and every hook's `pnpm test`, 2026-09-28 to 2026-10-03, all clean. The release will make test runs rarer; the capture and the tree below are what makes a late sighting usable. **Where a sighting lands:** every run through `scripts/bounded.mjs` (`pnpm test`, the hooks, conformance) is kept in `.test-runs/` since 2026-10-03, the newest 30, so a failure is still readable after a green rerun; a matrix keeps its own in `.matrix/`. Read its `stalled in` line and follow the tree.

**When it returns, the user's priority stands: reproduce it on demand, then remove the cause, so that CI never fails on valid code.** It has already refused a merge (`test/needs-skip-in-matrix`, first attempt), and five sightings put it past noise. Done means a reproduction that fails on demand — under load, with a squeezed timing, or with an instrumented holder — the cause named, and the fix verified against that reproduction. A raised timeout or a retry of the test is not a fix.

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
- `creator.write`, a worker `never initialized (boot: <step>)` — a fresh worker's open never finishes, and nothing in the client bounds a worker's startup (not verified beyond a grep): a consumer would hang the same way. Product-side. The step is `db.debug`'s `boot` since 2026-10-03, verified by holding the open lock from the page (`boot: waiting for the open lock`, both engines): `waiting for the client`, the `proceed` after the probe never came; `loading the build`, `instantiating wasm`, `loading the VFS module`, the engine never delivered a module; `creating the VFS`, `createVfsInstance` (its own retry is bounded, so a hang is inside the VFS's `create()`); `waiting for the open lock`, another worker or client holds `bsq:init`; `opening the database`, `openWithRetry`; `applying pragmas`, a pragma blocked; `no step`, the worker never ran `open`.
- `creator.close` — the drain never ends; the close path.
- `db.read` — the open under test after all; `openWithRetry` and `OPFSCoopSyncVFS`'s lock.

## wa-sqlite #371: `IDBMirrorVFS` commit-abort — OPENED 2026-10-03, waiting on rhashimoto

Offered on #363; rhashimoto: "Yes, please, if you're up for that." Defect: IDBMIRROR-COMMIT-ABORT; designs compared: IDBMIRROR-ABORT-JOURNAL, IDBMIRROR-ABORT-DESIGNS (`mem:measurements`).

**The user chose the reload design (2026-10-03)** after the measured comparison; the first pushed attempt (poison every call, as `OPFSPermutedVFS`) corrupts the store on reopen and was dropped. **The user asked whether to keep history: no PR was open, so the branch was rebuilt from upstream master `7fcc30df`** (which by then had #363, #369, #370 merged); the old local commits were kept on a backup branch, deleted on 2026-10-03. `fix/idb-mirror-commit-abort` = `1844c761` (fix) + `1f7b2533` (tests), force-pushed over the poison commits on the user's go, then **opened as rhashimoto/wa-sqlite#371**; body opens with "This one turned out trickier than I expected 😅" (user). Report `docs/upstream/2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md`.

What the fix does, each part with a test that fails without it (ablation, both engines): writes never fail (a failing batch write makes SQLite fall back to a journal that is later played back); `#commitTx` refuses a transaction built on an aborted view; a gate request (only while another commit is pending) drops commits queued behind the aborted one, since `abort()` throws after `commit()`; reload from IndexedDB at the next SHARED and in the `full` error path (`#loadFile` extracted from `jOpen`); `SQLITE_BUSY` at RESERVED while aborted (transparent with a busy timeout); the journal removed on `jClose` of an aborted file (else reopen stores the aborted rows, 12/12). Dropped after ablation showed no effect: a second check after `#commitTx`'s await, journal removal on reload, a guard in `#processBroadcasts`. Known limit: exclusive `normal` fails commits until reopen.

Evidence: 6 tests red on master both builds both engines; 190 tests 3/3 on Chromium and Firefox; suite 6274 passed; 168-probe matrix clean; perf = master within variation (9 interleaved runs). The test worker waits for pending commits before closing because closing first throws `InvalidStateError` from the broadcast — a separate defect, on master too, sent as #372 (entry below). **Body corrected 2026-10-03 (user):** the cost sentence now says commits confirmed before the connection learns of the abort are lost only in exclusive mode. **Revised the same day on the user's go: `3367cb65` reloads the view at the refusal unless a journal exists (IDBMIRROR-ABORT-RELOAD-ON-REFUSAL), so exclusive `normal` recovers after one `IOERR`; test adjusted (exclusive `normal` continues without reopen), body updated, comment 5971457674 posted; CI green (run 37139391822).** Carried in `patches/` since the repin to `7fcc30df`, merged with #372 since 2026-10-03 (`mem:stack-and-build`). Upstream CI green (runs 37137339446, 37139391822). What each answer calls for: changes → same worktree `.work/wa-sqlite-mirror-abort`, rerun the falsifiers, then rebuild the patch from both heads (the `jClose` conflict with #372 resolved as there); merge → repin.

## wa-sqlite #372: `IDBMirrorVFS` broadcasts a commit that completes after close — opened 2026-10-03, carried

With `synchronous=normal`, closing right after a commit made `oncomplete` post on the channel `jClose` had closed (`InvalidStateError`, uncaught), and — the real defect — the other connections never got the transaction: one that only reads stays on its old view until it writes, whose first attempt gets `SQLITE_BUSY`. Same when the context is terminated right after close (no error then). Fix sent: `jClose` awaits the commits in flight (`File.commitsInFlight`) before closing the channel. Skipping the broadcast once closed silenced the error and kept the stale readers; posting on a fresh channel missed terminated workers (IDBMIRROR-CLOSE-BROADCAST, `mem:measurements`). In this library: a second client stale and `BUSY` on its next write after the first client's `close()`, the error reaching the page on Chromium; gone with the carried patch.

`lalexdotcom:fix/idb-mirror-close-broadcast` = `a9811d75` (fix) + `69e00270` (tests), on `master` `7fcc30df`, **opened as rhashimoto/wa-sqlite#372** on the user's go. Based on master, not on #371, so the maintainer picks the merge order; the body names the conflict with #371 (`File` constructor, `jClose`, end of `#commitTx`) and promises to rebase whichever lands second (user). Carried in `patches/` merged with #371 (`mem:stack-and-build`). Upstream CI green on `69e00270` (run 37147812971). Report `docs/upstream/2026-10-03-wa-sqlite-372-idb-mirror-close-broadcast.md`. What each answer calls for: review changes → worktree `.work/wa-sqlite-close-broadcast`, rerun `test/IDBMirrorVFS.test.js` on both engines; #371 merges first → rebase #372 onto it (resolution: wait for commits in flight, then #371's journal removal) and drop `commitsFinished()` from #371's test worker if wanted; either merge → repin.

## wa-sqlite's own suite on Firefox: two failures on `master`, both test-side — asked as Discussion #373 (2026-10-03)

Upstream CI runs Chromium only, so neither shows there. Seen running the suite on Firefox (Playwright 1.62.1) for #372; both on `master` `7fcc30df`. **Neither is a VFS defect and neither reaches this library**, whose `OPFSWriteAheadVFS` answers a second client with `DATABASE_IN_USE` on Firefox and terminates a worker whose open fails (`mem:vfs`). Numbers: WA-FIREFOX-SQL-HANG, `mem:measurements`.
- **`vfs_read_freshness` on `OPFSWriteAheadVFS`** (default, asyncify, jspi): `unable to open database file` at the second connection. The test is ours (#365) and assumes two connections; on Firefox, without `readwrite-unsafe`, the VFS keeps its access handles for a connection's life.
- **`sql.test.js` hangs, caused by `OPFSWriteAheadVFS`'s `sql_0005`.** Same assumption: its second of eight connections fails to open on Firefox. Then three harness traits make a failure a hang: `sql_0005` registers a worker's cleanup only after a successful open, so the worker whose open failed is never destroyed, and its VFS keeps its `.session-*` directory and temp-file handles; the next `context.create()` with `reset` cannot empty OPFS (`maybeReset` retries `NoModificationAllowedError` for 10 s, then rejects unhandled, so the worker never posts its port); `TestContext.create()` listens for that message only and waits for ever. Jasmine runs in random order (`random: true`, not overridden by `web-test-runner-jasmine`), so the file hangs only when a resetting spec runs after that failure — hence one `master` run that finished.
- **Asked upstream: Discussion rhashimoto/wa-sqlite#373 ("Should the test suite also run on Firefox?", category Ideas), opened 2026-10-03 on the user's go.** It gives the case for Firefox (no `readwrite-unsafe`, as on Safari; #363, #367 and #369 Firefox-only or worse there; JSPI on Firefox; Playwright's WebKit on Linux has no OPFS), the two adaptations above, owns `vfs_read_freshness`'s assumption (#365), and offers a PR. What each answer calls for: **yes** → one PR, test-only: `@web/test-runner-playwright` with Firefox in the config and the workflow, the multi-connection `OPFSWriteAheadVFS` tests skipped where `'mode' in FileSystemSyncAccessHandle.prototype` is false, `sql_0005` registering each worker's destroy before its open, `TestContext.create()` rejecting when the worker fails during setup; rerun the whole suite on both engines. **Chromium-only by choice** → close the entry.

## wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR not decided

Open issue by jwaltz, 2026-09-25, no PR: `OPFSCoopSyncVFS.create()` fails with `NoModificationAllowedError` after a back/forward-cache navigation — the `.ahp-*` sweep in `#initialize()` gets the lock while the cached page's worker still holds its temp handles, and `removeEntry` throws; only `NotFoundError` is tolerated there, since our #347. An immediate retry succeeds; his suggested fix (try/catch around the sweep's `removeEntry`) gave 0/48. The library masks it: `createVfsInstance` retries `create()` on `NoModificationAllowedError`. With the real navigation on Chromium, wa-sqlite alone fails its first open 18 times of 18 and the library's succeeds 18 of 18, ~85 ms later than without a cached page (LEAK-LIB, `mem:measurements`). A PR for #362 was proposed to the user, not decided.

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

## Move to Playwright 1.64.0 as soon as it is released stable — its Firefox fixes the young-worker segfault (user, 2026-10-03)

Playwright's Firefox loses the page's content process when a worker is `terminate()`d a few ms after `new Worker(...)` (LIFECYCLE-SEGV, `mem:measurements`). **Already fixed upstream, no issue to open:** it is microsoft/playwright#42565 (a worker torn down while its script compiles, a regression of 1.62.0's `firefox-1538`), fixed by the Gecko patch rolled in #42631 (`r1544`, 2026-09-09). Checked 2026-10-03 with a one-spec reproduction (`about:blank`, two blob workers terminated 0-6 ms after creation, 150 rounds): Playwright 1.63.0 (`firefox-1543`, Firefox 155.0) 5/5 `Target crashed`, and its binary launched alone 10/10, against Mozilla's Firefox 155.0 10/10 clean; `@playwright/test@1.64.0-alpha-2026-10-03` (`firefox-1554`) 10/10 clean on Firefox. **To do when 1.64.0 is released stable** (not an alpha; `npm view playwright dist-tags` → `latest`): bump `playwright` in `package.json` (pinned at 1.62.1), then **make sure the Firefox actually used is the new build**, `firefox-1554` or later:
- locally, `.devcontainer/post-create.sh` installs browsers only when the container is created, so run `pnpm exec playwright install --with-deps chromium firefox` by hand; the old `firefox-1538` stays in `~/.cache/ms-playwright` and is simply no longer chosen;
- check with `node -e "console.log(require('playwright').firefox.executablePath())"` that the path names the new revision and exists, and that rstest runs on it (the browser provider uses the project's `playwright`);
- in CI the browser cache is keyed on `pnpm-lock.yaml` (`ci.yaml`, `release-and-publish.yaml`), so the bump renews it by itself;
- then rerun the Firefox config, and the one-spec reproduction above if in doubt;
- **and remeasure the rstest/Firefox `getDirectory()` hang** (its entry below, same level: what each result calls for is there). The test-side guard in `lifecycle.test.ts` (kill a silent worker only after its boot signal) stays either way. The `DOM Worker` thread leak of the same builds (WORKER-LEAK) was not re-measured on `firefox-1554`; it never reaches the 512-worker cap in the suite.

## The rstest/Firefox silent hang — CAUSE FOUND 2026-09-16, fix not taken — waits for the Playwright 1.64 bump (user, 2026-10-03)

**Tied to the Playwright 1.64.0 entry above, at the same level: nothing to do before that bump, then remeasure (user, 2026-10-03).** Every sighting is on Playwright's patched Firefox, whose young-worker segfault turned out to be the build's own and is fixed in 1.64, so this may be the same story. After the bump: the unguarded probe arm, Firefox, `OPFSWriteAheadVFS/sync`, 24 runs, against 4/24 then. **Gone** → close this entry: it was the build's, and the library was never concerned. **Still there** → try a stock Firefox: if stock hangs too, the library is exposed for real — its workers call `getDirectory()` in every OPFS VFS's `create()` and in `worker.ts`'s delete and inspect paths, and nothing in the client bounds a worker's startup (`db.debug`'s `boot` would read `creating the VFS`) — so the question becomes bounding worker startup in the client, then the one-probe-per-run design below for the tests, and the Mozilla report.


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
  Merged upstream (`27a6a0b6`, seen 2026-10-03); the repin to `7fcc30df` dropped the hunk. Guarded here by `tests/browser/vacuum.test.ts` (need
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

## wa-sqlite: `OPFSAdaptiveVFS.js` reads `FileSystemSyncAccessHandle.prototype` at module load — carried, opened as #374 (2026-10-03)

Line 9, `globalThis.FileSystemSyncAccessHandle.prototype.hasOwnProperty('mode')`, unguarded. Every VFS is bundled into the one worker file, so where the interface is missing the worker cannot load at all, memory VFS included. **Measured 2026-10-03 (INSECURE-CONTEXT, `mem:measurements`): outside a secure context, once the library's own `crypto.randomUUID` was gone, every client failed `WORKER_CRASHED` on that line, Chromium and Firefox.** Fixed in our build by a one-character guard (`?.`), carried in `patches/` with #371 and #372 since 2026-10-03. **PR (2026-10-03):** `lalexdotcom:fix/adaptive-missing-sync-handle` on `master` `7fcc30df`, pushed: the guard (`39e7e1ff`, byte-identical to the carried one) and a test (`80934a52`) that imports the module from the test page, a main thread where the interface is undefined — red on master on Chromium and Firefox, the file's 72 tests 3/3 green with the fix, suite 6158 on Chromium. (An `expectAsync(import(...)).toBeResolved()` form hung the page on master instead of failing; the test catches the import error itself.) Its case: main thread and Node, insecure pages, and browsers older than the interface (Chrome < 102, Android < 109, Firefox < 111), where a worker bundling several VFS fails as a whole. **Opened as rhashimoto/wa-sqlite#374 on 2026-10-03**, body as validated by the user; report `docs/upstream/2026-10-03-wa-sqlite-374-adaptive-missing-sync-handle.md`. What each answer calls for: review changes → the worktree `.work/wa-sqlite-adaptive-guard`, rerun `test/OPFSAdaptiveVFS.test.js` red on master and green with the change, both engines, and update the carried line; merge → repin and drop the line from the patch.

## Full documentation pass before the release (user, 2026-10-03)

Before the 1.0, reread the consumer docs (`README.md`, `API.md`, `VFS.md` and its generator) as a whole. Already known to go in it:
- **An "https required: ✅ / ❌" row in the VFS table, or in each VFS's own section** (user): ❌ for `MemoryVFS` and `MemoryAsyncVFS`, ✅ for every other VFS, which needs OPFS or the Web Locks API, both withheld outside a secure context. `VFS.md` is generated (`scripts/render-vfs-matrix.ts`), so the row comes from `VFS_CAPABILITIES` (`requires` holds `opfs` or `web-locks`), not by hand.
- The 80-column hard wrap of the consumer docs (entry above).
- **`VFS.md` gives the OPFS VFS a Chrome floor that is too low.** `FEATURE_SUPPORT.opfs` in the generator holds one version per browser, `getDirectory`'s (Chrome 86), and its comment says `createSyncAccessHandle` gives the same versions; browser-compat-data says otherwise: `FileSystemFileHandle.createSyncAccessHandle` and `FileSystemSyncAccessHandle` are Chrome 102, Chrome Android 109, Firefox 111, Safari 15.2 (checked 2026-10-03). The four VFS that open sync access handles (`OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`, `AccessHandlePoolVFS`) show Chrome 92+ where 102+ is true; `OPFSAnyContextVFS` writes through `createWritable` and may be right. Likely a separate feature (`sync-access-handle`) in the generator.

## Notes, with nothing to fix

### What no test can see about the statement cache

**The drain before `close` is falsifiable by nothing.** Deleting it leaves the whole suite
green: `sqlite3_close` returns `SQLITE_BUSY`, the close path's `catch` swallows it, and the
pool terminates the worker regardless, releasing every OPFS handle. Two observations were
tried and neither sees it — `deleteDatabase` after `close()`, and reopening the same
database. The test comment says so plainly rather than claiming a falsifier. The
whole-branch review's verdict on that swallowing `catch`: **not a defect** — a worker that
failed to open has nothing to close, and the worker dies either way. Reopen only if a future
close path must tell "nothing to close" from "close refused".

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
