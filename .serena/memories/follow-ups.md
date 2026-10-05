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

**DORMANT: no action until it happens again (user, 2026-10-03).** Reproduction attempts are over (below), and nothing since the test names its stall: 13 full matrices of 22 Firefox cells each and every hook's `pnpm test`, 2026-09-28 to 2026-10-03, all clean. The release will make test runs rarer; the capture and the tree below are what makes a late sighting usable. **Where a sighting lands:** every run through `scripts/bounded.ts` (`pnpm test`, the hooks, conformance) is kept in `.test-runs/` since 2026-10-03, the newest 30, so a failure is still readable after a green rerun; a matrix keeps its own in `.matrix/`. Read its `stalled in` line and follow the tree.

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

## rstest: browser mode cannot open a persistent context — issue/PR to send upstream (user, 2026-10-05)

`@rstest/browser` creates every context with `browser.newContext()`, an ephemeral one, hard-coded in `launchPlaywrightBrowser` (0.11.8, ours, and 0.12.3, latest on 2026-10-05). `browser.providerOptions` ([web-infra-dev/rstest#1041](https://github.com/web-infra-dev/rstest/pull/1041)) only passes `launch` to `browserType.launch()` and `context` to `newContext()`'s options: the context's nature cannot be changed. Searched 2026-10-05 (issues, PRs, discussions: persistent, `launchPersistentContext`, `userDataDir`, OPFS, incognito, `newContext`): nothing upstream raises it; [#1799](https://github.com/web-infra-dev/rstest/pull/1799)'s `contextOptions` is the Node-side `@rstest/playwright`, browser mode untouched.

Two measured costs to put in the issue:
- **WebKit has no OPFS in an ephemeral context.** Playwright's docs: "OPFS is currently not supported in ephemeral WebKit contexts". Probed on GitHub Actions (ubuntu, 2026-10-05, a dedicated worker on `http://localhost`): Playwright 1.63.0 (WebKit 26.6) ephemeral → `getDirectory()` rejects `UnknownError`; persistent → `getDirectory()`, `createSyncAccessHandle` write/read and `createWritable` all work. 1.62.1 (WebKit 26.5, our pin) has no `navigator.storage` in either context — the August finding behind dropping WebKit was the version, not the Linux port; the fix is microsoft/playwright#41984 (WebKit r2339, shipped in 1.63.0).
- **Chromium's ephemeral OPFS costs ~250× per call** (RSTEST-OTR, `mem:measurements/suite-and-matrix`).

What to send: an issue proposing an opt-in persistent context for the Playwright provider (e.g. `providerOptions.persistentContext`, one fresh temporary profile per context through `browserType.launchPersistentContext`), with both measurements and a minimal reproduction; offer the PR. Outward-facing: waits for the user's go. Until it lands, a `pnpm patch` of `@rstest/browser` doing the same is what a WebKit project of our own would need (the WebKit-in-our-tests idea of 2026-10-05: Playwright 1.63+, WebKit installed with `PLAYWRIGHT_SKIP_BROWSER_GC=1` so the other revisions survive, persistent context for WebKit first).

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
reason. `scripts/bounded.ts` now gives every browser script a deadline (exit 124), because the
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

Numbers in `mem:measurements`. `scripts/matrix-triage.ts` regenerates the grouping from any
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

Line 9, `globalThis.FileSystemSyncAccessHandle.prototype.hasOwnProperty('mode')`, unguarded. Every VFS is bundled into the one worker file, so where the interface is missing the worker cannot load at all, memory VFS included. **Measured 2026-10-03 (INSECURE-CONTEXT, `mem:measurements`): outside a secure context, once the library's own `crypto.randomUUID` was gone, every client failed `WORKER_CRASHED` on that line, Chromium and Firefox.** Fixed in our build by a one-character guard (`?.`), carried in `patches/` with #371 and #372 since 2026-10-03. **PR (2026-10-03):** `lalexdotcom:fix/adaptive-missing-sync-handle` on `master` `7fcc30df`, pushed: the guard (`39e7e1ff`, byte-identical to the carried one) and a test (`80934a52`) that imports the module from the test page, a main thread where the interface is undefined — red on master on Chromium and Firefox, the file's 72 tests 3/3 green with the fix, suite 6158 on Chromium. (An `expectAsync(import(...)).toBeResolved()` form hung the page on master instead of failing; the test catches the import error itself.) Its case: main thread and Node, insecure pages, and browsers older than the interface (Chrome < 102, Android < 109, Firefox < 111), where a worker bundling several VFS fails as a whole. **Opened as rhashimoto/wa-sqlite#374 on 2026-10-03**, body as validated by the user; upstream CI green (run 37157798485); report `docs/upstream/2026-10-03-wa-sqlite-374-adaptive-missing-sync-handle.md`. What each answer calls for: review changes → the worktree `.work/wa-sqlite-adaptive-guard`, rerun `test/OPFSAdaptiveVFS.test.js` red on master and green with the change, both engines, and update the carried line; merge → repin and drop the line from the patch.

## Read workers refuse writes themselves, with `sqlite3_stmt_readonly` — not started (user, 2026-10-04)

Today the one-writer invariant rests on the client's routing regex (`isReadQuery`: an allowlisted opening keyword and no write keyword anywhere). Proposed by the user after the transaction-control guard (`feat/tx-savepoint`): the worker checks each prepared statement on a read lease — cache hits included — before its first `step`, so a misrouted write can never run on a read worker. **The primitive is `sqlite3_stmt_readonly`, not the authorizer**: one wasm export call per prepared statement, SQLite deciding, no per-action JS callback (so no Firefox `jspi` relay cost); `Module._sqlite3_stmt_readonly` is exported by all three builds (checked 2026-10-04), not wrapped by `sqlite-api.js`. It complements the routing, which picks the worker before any prepare; it could then let the regex relax its false positives (`SELECT 'INSERT'` serialized through the writer, `db.read("SELECT … 'BEGIN'")` refused) — but `first()`/`chunk()`/`stream()` accept writes (`INSERT … RETURNING`), so they keep the regex or retry on the writer.

**Measure first:** what `stmt_readonly` answers for statements that change only connection state — `ATTACH`, `DETACH`, `PRAGMA x = y`, `CREATE TEMP TABLE` — which would make one read worker diverge from the others; those may need the authorizer (`SQLITE_ATTACH`, `SQLITE_DETACH`, `SQLITE_PRAGMA` with a value) or the client rule kept. And the cost per prepare.

## wa-sqlite #375: the `jspi` build wraps its synchronous relays in `WebAssembly.Suspending` — opened 2026-10-05, carried

Cause, change, measurements and the carry: `docs/upstream/2026-10-05-wa-sqlite-375-sync-relays-plain-imports.md`. The PR removes `src/asyncify_imports.json` and `ASYNCIFY_IMPORTS` from both builds, with `dist` rebuilt (emsdk 3.1.61); Firefox `jspi` per call 3.5-4.9× cheaper, `async` unchanged on both engines. The patch carries only `dist/wa-sqlite-jspi.mjs`, byte-identical to the PR. **Order the user set (2026-10-05): validate upstream, then the PR, then the carry** — this entry had them the other way round. What each answer calls for: changes → the worktree `.work/wa-sqlite-jspi-imports`, rebuild `dist` with `emscripten/emsdk:3.1.61-arm64` (delete the outputs first: `make` trusts restored mtimes), rerun the suite on both engines, then rebuild the carried hunk from the new `wa-sqlite-jspi.mjs`; merge → repin, and drop the hunk. It matters to the `tx.savepoint()` design: the authorizer guard's Firefox `jspi` cost falls with it.

## Full documentation pass before the release (user, 2026-10-03)

Before the 1.0, reread the consumer docs (`README.md`, `API.md`, `VFS.md` and its generator) as a whole. Already known to go in it:
- **An "https required: ✅ / ❌" row in the VFS table, or in each VFS's own section** (user): ❌ for `MemoryVFS` and `MemoryAsyncVFS`, ✅ for every other VFS, which needs OPFS or the Web Locks API, both withheld outside a secure context. `VFS.md` is generated (`scripts/render-vfs-matrix.ts`), so the row comes from `VFS_CAPABILITIES` (`requires` holds `opfs` or `web-locks`), not by hand.
- The 80-column hard wrap of the consumer docs (entry above).
- **Say up front that the library is opinionated (user, 2026-10-03)**: it makes many choices for the consumer — writes serialized through one writer, `BEGIN IMMEDIATE` for write transactions, the default build per engine, and soon transaction control refused outside `transaction()` / `tx.savepoint()` (the `tx.savepoint()` brainstorm, 2026-10-03). The README should state it as a stance, not leave each choice to be discovered as a refusal.
- **No counts where the number is not the point (user, 2026-10-03)**: `README.md` says `pnpm test:consumer` "drives four bundler modes" while the smoke runs five bundlers plus the bundler-free mode — a count that went stale because it was written down. "several bundler modes", or naming them, says the same and cannot drift. Sweep the consumer docs for the same shape.
- **`VFS.md` gives the OPFS VFS a Chrome floor that is too low.** `FEATURE_SUPPORT.opfs` in the generator holds one version per browser, `getDirectory`'s (Chrome 86), and its comment says `createSyncAccessHandle` gives the same versions; browser-compat-data says otherwise: `FileSystemFileHandle.createSyncAccessHandle` and `FileSystemSyncAccessHandle` are Chrome 102, Chrome Android 109, Firefox 111, Safari 15.2 (checked 2026-10-03). The four VFS that open sync access handles (`OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`, `AccessHandlePoolVFS`) show Chrome 92+ where 102+ is true; `OPFSAnyContextVFS` writes through `createWritable` and may be right. Likely a separate feature (`sync-access-handle`) in the generator.

## Notes, with nothing to fix

In `mem:follow-ups/notes`.
