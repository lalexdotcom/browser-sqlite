# Follow-ups — the open backlog

One short entry each, and every entry OPEN. **An entry marked DORMANT waits for an event and needs no action until it comes: it is not part of the backlog and is not listed when the user asks for it (user, 2026-10-03).** Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**The `step()` workstream lives in `mem:follow-ups/wa-step` (2026-10-08).** **Entries waiting on an event live in `mem:follow-ups/dormant`** — `open-retry` on Firefox and wa-sqlite #297 `trace_v2`, moved there on 2026-10-05 to keep this file under 40 000 characters.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## wa-sqlite's async `step()` wrapper costs every read, most on Firefox — a dedicated workstream for a new session (user, 2026-10-08)

In `mem:follow-ups/wa-step`: the scope the user set, what each solution (library-side fast step, three upstream forms) asks of the library, the measurements on Firefox, Chromium and WebKit, and what an upstream Discussion would rest on.

## `multi-client` bulkWrite interleave on chromium `IDBMirrorVFS/async` — seen, not reproducible (2026-10-07)

`tests/browser/multi-client.test.ts` :: "two clients writing at once > interleaves a bulkWrite with another client, refusing neither" failed once in the `feat/binary-protocol` matrix: client A read 0 of B's first 2 047-row batch over its 5 s of polling (`expected +0 to be 2047`, test 10.9 s). Replays the same afternoon: the test alone 10/10 on the branch and on `main`; the file under 16 busy loops 15/15 each; the full cell on the branch 1 failure in 5 then 0 in 15 (and 0 in 12 with `debug: true` and a diagnostic of B's `close()` and A's late count), on `main` 0 in 20. Another session's Firefox was loading the machine during the failing runs. Left by the user's decision ("on ignore et on enchaîne, et on consigne"). At the next sighting: rerun the cell with the diagnostic (B's `writer.close()` outcome — a failed batch against a slow one — and A's count after it), and compare with `main` at the same load.

## `WORKER_BUSY` after an aborted read, chromium `jspi` — seen twice under the matrix, not reproduced (2026-10-09)

**Second sighting, the same afternoon:** the `fix/multi-statement-params` matrix (65/66, 2047 s) failed the same test with the same `WORKER_BUSY`, this time on chromium `MemoryVFS/jspi`, in 70 ms. Not reproduced again: the cell alone 3/3, the test alone 20/20 on that target. Both sightings are `jspi` and inside a full matrix run; the branch's change touched only multi-statement binding in the worker, which this single-statement test never reaches. The first sighting is below.


The 2026-10-09 baseline matrix (`main` after `feat/sql-tag`) failed one test in one cell: `tests/browser/params.test.ts` › "rebinds a cached statement after an aborted query" — `poolSize: 1`, a 50 M-row recursive read aborted after 50 ms, then a second read at once — rejected with `WORKER_BUSY` from `pool.ts`'s `runQuery`, the invariant that one worker serves one query (`mem:architecture`, "The lease returns on quiesce"). So the second read reached the worker while the aborted one was still in flight there. Not reproduced: the cell alone 3/3 green, the test alone 20/20 green, same target. The matrix of 2026-10-08 was 66/66 and `feat/sql-tag` only unpacks arguments before the lease. If it recurs: suspect the abort path's lease release against `quiesce()` on `jspi` (a build whose step suspends), and reproduce under load (busy loops beside a single-cell run cut time-to-failure twentyfold for ABANDON-WEDGE, `mem:measurements/aborts`).

## wa-sqlite #371: `IDBMirrorVFS` commit-abort — OPENED 2026-10-03, waiting on rhashimoto

Offered on #363; rhashimoto: "Yes, please, if you're up for that." Defect: IDBMIRROR-COMMIT-ABORT; designs compared: IDBMIRROR-ABORT-JOURNAL, IDBMIRROR-ABORT-DESIGNS (`mem:measurements`).

**The user chose the reload design (2026-10-03)** after the measured comparison; the first pushed attempt (poison every call, as `OPFSPermutedVFS`) corrupts the store on reopen and was dropped. **The user asked whether to keep history: no PR was open, so the branch was rebuilt from upstream master `7fcc30df`** (which by then had #363, #369, #370 merged); the old local commits were kept on a backup branch, deleted on 2026-10-03. `fix/idb-mirror-commit-abort` = `1844c761` (fix) + `1f7b2533` (tests), force-pushed over the poison commits on the user's go, then **opened as rhashimoto/wa-sqlite#371**; body opens with "This one turned out trickier than I expected 😅" (user). Report `docs/upstream/2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md`.

What the fix does, each part with a test that fails without it (ablation, both engines): writes never fail (a failing batch write makes SQLite fall back to a journal that is later played back); `#commitTx` refuses a transaction built on an aborted view; a gate request (only while another commit is pending) drops commits queued behind the aborted one, since `abort()` throws after `commit()`; reload from IndexedDB at the next SHARED and in the `full` error path (`#loadFile` extracted from `jOpen`); `SQLITE_BUSY` at RESERVED while aborted (transparent with a busy timeout); the journal removed on `jClose` of an aborted file (else reopen stores the aborted rows, 12/12). Dropped after ablation showed no effect: a second check after `#commitTx`'s await, journal removal on reload, a guard in `#processBroadcasts`. Known limit: exclusive `normal` fails commits until reopen.

Evidence: 6 tests red on master both builds both engines; 190 tests 3/3 on Chromium and Firefox; suite 6274 passed; 168-probe matrix clean; perf = master within variation (9 interleaved runs). The test worker waits for pending commits before closing because closing first throws `InvalidStateError` from the broadcast — a separate defect, on master too, sent as #372 (entry below). **Body corrected 2026-10-03 (user):** the cost sentence now says commits confirmed before the connection learns of the abort are lost only in exclusive mode. **Revised the same day on the user's go: `3367cb65` reloads the view at the refusal unless a journal exists (IDBMIRROR-ABORT-RELOAD-ON-REFUSAL), so exclusive `normal` recovers after one `IOERR`; test adjusted (exclusive `normal` continues without reopen), body updated, comment 5971457674 posted; CI green (run 37139391822).** Carried in `patches/` since the repin to `7fcc30df`, merged with #372 since 2026-10-03 (`mem:stack-and-build`). Upstream CI green (runs 37137339446, 37139391822). What each answer calls for: changes → same worktree `.work/wa-sqlite-mirror-abort`, rerun the falsifiers, then rebuild the patch from both heads (the `jClose` conflict with #372 resolved as there); merge → repin.

## wa-sqlite #372: `IDBMirrorVFS` broadcasts a commit that completes after close — opened 2026-10-03, carried

With `synchronous=normal`, closing right after a commit made `oncomplete` post on the channel `jClose` had closed (`InvalidStateError`, uncaught), and — the real defect — the other connections never got the transaction: one that only reads stays on its old view until it writes, whose first attempt gets `SQLITE_BUSY`. Same when the context is terminated right after close (no error then). Fix sent: `jClose` awaits the commits in flight (`File.commitsInFlight`) before closing the channel. Skipping the broadcast once closed silenced the error and kept the stale readers; posting on a fresh channel missed terminated workers (IDBMIRROR-CLOSE-BROADCAST, `mem:measurements`). In this library: a second client stale and `BUSY` on its next write after the first client's `close()`, the error reaching the page on Chromium; gone with the carried patch.

`lalexdotcom:fix/idb-mirror-close-broadcast` = `a9811d75` (fix) + `69e00270` (tests), on `master` `7fcc30df`, **opened as rhashimoto/wa-sqlite#372** on the user's go. Based on master, not on #371, so the maintainer picks the merge order; the body names the conflict with #371 (`File` constructor, `jClose`, end of `#commitTx`) and promises to rebase whichever lands second (user). Carried in `patches/` merged with #371 (`mem:stack-and-build`). Upstream CI green on `69e00270` (run 37147812971). Report `docs/upstream/2026-10-03-wa-sqlite-372-idb-mirror-close-broadcast.md`. What each answer calls for: review changes → worktree `.work/wa-sqlite-close-broadcast`, rerun `test/IDBMirrorVFS.test.js` on both engines; #371 merges first → rebase #372 onto it (resolution: wait for commits in flight, then #371's journal removal) and drop `commitsFinished()` from #371's test worker if wanted; either merge → repin.

## wa-sqlite's suite on stock browsers — revised proposal posted, waiting on rhashimoto (Discussion #373, 2026-10-08)

**Where it stands.** On the user's go, a top-level comment was posted on rhashimoto/wa-sqlite#373 on 2026-10-08 (discussioncomment-18824045). It revises the plan he had validated, after two days of measurements on the fork (`mem:measurements/test-browsers`). **Nothing is started on the PR until he answers.** The user's principles behind it are in `mem:conventions` (§ Testing in browsers).

**What the comment proposes:**
- **Stock browsers through WebDriver** (`@web/test-runner-webdriver`), Playwright dropped, which revisits his answer 1 (Playwright's bundled Chromium). The reason given: test what users run; patched builds are noise.
- **Development:** `yarn test` runs Chrome only by default, and `WTR_BROWSERS` picks others (`chrome,firefox`, plus `safari` on macOS).
- **CI:** one reusable workflow with the steps, and one small workflow per platform: Linux (Chrome, Firefox), Windows (Chrome, Firefox), macOS (Chrome, Firefox, Safari). Triggers are his to choose per platform; the example given is all on a release, Linux on PRs and pushes to master, and any by `workflow_dispatch`. The WASM is built once with `make` and shared by every job.
- **The DataView race** (SAFARI26-DATAVIEW-RACE) goes as its own commit in the test PR, not a PR of its own: only Safari exposes it.
- **`sql_0005` on `IDBMirrorVFS`** is skipped on Safari before 27 with `pending()` and its reason (SAFARI26-IDBMIRROR-KILL).
- **The `readwrite-unsafe` skips** stay as agreed.
- **Windows:** geckodriver comes from the runner, and the docs will tell Windows contributors to install it.
- **Mobile:** iOS Safari can follow the macOS images' simulators (iOS 26 works, iOS 27 refuses). Chrome on Android is not explored, only said possible.

**What his answer calls for, if he agrees.** The PR branch, from upstream `master`, in this order:
1. **Test and harness commits:**
   - the capability skips: `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` without `FileSystemSyncAccessHandle.prototype.mode`, and `vfs_open_last_error` accepting `InvalidStateError`;
   - `sql_0005` registering each worker's cleanup before its open;
   - `TestContext.create()` rejecting when the worker reports an error;
   - `destroy()` closing the VFS before `terminate()`;
   - the DataView race fix, ported from `68aae811` on the fork;
   - the Safari-before-27 skip, through a `TestContext` helper reading `Version/NN` from the user agent (the same on macOS and iOS).
2. **Config:** `WTR_BROWSERS`, with Chrome as the default.
3. **Workflows:** as proposed above.
4. **Docs:** a "Running the tests" section per OS.

Before opening it, measure reliability: about 10 runs per environment, through `workflow_dispatch` on the fork. Upstream's JSPI flag is not needed on stock Chrome 154.

**Still open:**
- Linux Firefox lost two files at the launcher once in 8 runs, unexplained.
- Windows Firefox has only one complete run.
- iOS 27 simulators refuse WebDriver sessions; the image `20261006` with Safari 27.0.1 is untried.
- The fork's `probe/stock-browsers` (head `437e6de1`) and `probe/webkit-opfs` are throwaway.

**History, compressed.**
- **2026-10-03:** asked, about Firefox.
- **2026-10-04:** he pointed at WebKit and Playwright's private mode.
- **2026-10-05:** we measured WebKit's OPFS in a persistent context and proposed WebKit; he asked for all three browsers by default, with an environment variable to restrict to one.
- **2026-10-06:** design questions (discussioncomment-18773230). He answered: Playwright's Chromium, `WTR_BROWSERS`, drop the pre-build pass, both skips, `create()` rejecting, `destroy()` closing the VFS, one PR.
- **2026-10-07:** confirmed (discussioncomment-18791734).

The Firefox findings that started it (WA-FIREFOX-SQL-HANG): `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` assume two connections, which Firefox without `readwrite-unsafe` refuses. Three harness traits then turn that failed open into a hang:
- `sql_0005` registered a worker's cleanup only after its open, so the failed worker was never destroyed;
- `maybeReset` retried `NoModificationAllowedError` for 10 s, then rejected without posting a port;
- `TestContext.create()` waited for ever for that port.

Jasmine's random order decides whether a resetting spec follows the failure. None of this is a VFS defect, and none of it reaches the library.

## The library's tests on stock browsers — Vitest + WebdriverIO to probe (user, 2026-10-08)

**The user's direction** (`mem:conventions`, § Testing in browsers): the library's browser tests should also run on stock browsers, Safari and iOS through GitHub's macOS images. rstest has no WebDriver and is pre-1.0, and reusing the rslib config does not make up for that. Testing the rslib-built `dist/` is worth considering. **Parked by the user the same day, to finish wa-sqlite first.**

**The candidate is Vitest's browser mode with `@vitest/browser-webdriverio`.** Read on 2026-10-08:
- Vitest 5.0.3 is current.
- **Since Vitest 5 the WebdriverIO provider is community-maintained** (`vitest-community/vitest-webdriverio`, created 2026-06, 5 stars); the Playwright provider is the core one.
- It declares Chrome, Firefox, Edge and Safari, with `supportsParallelism = false` and no headless Safari.
- It runs the tests **inside an iframe of an orchestrator page**: OPFS, workers and IndexedDB there are unverified.
- iOS is not a declared browser.

**Before deciding:** probe a handful of the library's tests (OPFS, workers, IndexedDB) on Chrome, Firefox and Safari, on Linux, Windows and macOS. Its own branch.

**Also owed by that direction:**
- The devcontainer gets Debian's `chromium` and `chromium-driver` for a local Chrome. Google publishes no Chrome for Linux arm64, and Chrome for Testing has no linux-arm64 build either.
- **An unmeasured exposure:** the library's `IDBMirrorVFS` with several connections on Safari 26 may stall the way wa-sqlite's `sql_0005` does (SAFARI26-IDBMIRROR-KILL).

## wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR not decided

Open issue by jwaltz, 2026-09-25, no PR: `OPFSCoopSyncVFS.create()` fails with `NoModificationAllowedError` after a back/forward-cache navigation — the `.ahp-*` sweep in `#initialize()` gets the lock while the cached page's worker still holds its temp handles, and `removeEntry` throws; only `NotFoundError` is tolerated there, since our #347. An immediate retry succeeds; his suggested fix (try/catch around the sweep's `removeEntry`) gave 0/48. The library masks it: `createVfsInstance` retries `create()` on `NoModificationAllowedError`. With the real navigation on Chromium, wa-sqlite alone fails its first open 18 times of 18 and the library's succeeds 18 of 18, ~85 ms later than without a cached page (LEAK-LIB, `mem:measurements`). A PR for #362 was proposed to the user, not decided.

## rstest: browser mode cannot open a persistent context — issue/PR to send upstream (user, 2026-10-05)

**Lower priority since 2026-10-08:** the user's direction for the library's tests is stock browsers through WebDriver, which rstest does not offer (entry "The library's tests on stock browsers" above). This issue matters only if the library stays on rstest.

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
SharedWorker cannot open a connection on the four VFS that matter (`mem:architecture/cross-tab`). So the
measured numbers are the whole case, and they do not justify adding a handshake to the open
path — the path GATE-1 and three abort defects were paid for. Reviving it needs no new
measurement, only that table.

### Recycling the params buffer through `done` — an idea, kept out of the binary protocol (user, 2026-10-07)

The worker hands the transferred params buffer back in `done`, the page reuses it for the next send. Measured (BINARY-PROTOCOL, `mem:measurements/binary-protocol`): on 200 writes of a 1 MiB text it halves the peak again over the plain binary path (Chromium 29-40 → 16 MB, Firefox 50-77 → 25 MB), and gains nothing on small queries. Cost: each worker keeps its largest buffer for life (~3 MiB for a 1 MiB text, worst-case sizing), and `done` grows an optional field — so it can be added later without breaking the protocol. If taken up: cap the size kept per worker; the cap is unmeasured.

### Buffer strategy of the binary blocks, both directions — a measurement to take if the choice is questioned (user, 2026-10-08)

The two sides grow their buffers differently, on purpose: `ParamsWriter` knows the size before writing (`encodeParams` sizes for the worst case; `bulkWrite` batches are large), so it uses 1 MiB segments and never copies; the result `RowWriter` (spec 2026-10-08) learns the size row by row, so it keeps one buffer per chunk that doubles by copy, sized from the query's previous chunk. Growable `ArrayBuffer`s (`resize`, `transfer`) were refused on 2026-10-07 for raising the browser floor (Firefox → 122-128). Unmeasured alternative for rows: segments of doubling size capped at 1 MiB (no copy, a test per value at decoding). Should either choice be questioned, measure both arms on each side with the direct harness (RESULT-BINARY / BINARY-PROTOCOL).

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


## What the matrix showed, and what it shows now (2026-09-16, resolved 2026-09-18)

**The three product defects are gone.** Full matrix on 2026-09-18 after the fixes: 65 of 66 cells
green, 1 failing test, 1 distinct group — against 62 cell-failures and 20 groups on 2026-09-16.
**Re-measured 2026-09-21 once that one was fixed (`2be2ae6`): 66 of 66 cells green, 0 failing
tests, 2650 s.** Every one of the three traced to a
wa-sqlite defect rather than to this library, and each is upstream with a falsifying test in
wa-sqlite's own suite: `OPFSCoopSyncVFS` → #350 plus our own `deleteDatabase` probe (a file's
existence, not an open), `IDBBatchAtomicVFS` → #351, `IDBMirrorVFS` → #352 and #353. Reports in
`docs/upstream/`, patch inventory in `mem:stack-and-build/wa-sqlite`.

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

**Known (2026-10-09, wa-sqlite's SQLite 3.53.0):** `PRAGMA cache_size(10)` answers `stmt_readonly` = 1 and runs on a read-only connection, though it changes the connection — so `stmt_readonly` alone would admit setting pragmas. **Measure first:** what `stmt_readonly` answers for the other statements that change only connection state — `ATTACH`, `DETACH`, `PRAGMA x = y`, `CREATE TEMP TABLE` — which would make one read worker diverge from the others; those may need the authorizer (`SQLITE_ATTACH`, `SQLITE_DETACH`, `SQLITE_PRAGMA` with a value) or the client rule kept. And the cost per prepare.

## `jspi` before `sync` in the build order — to examine (user, 2026-10-05)

Measured on 2026-10-05 (JSPI-VS-SYNC, `mem:measurements/statement-cache-and-perf`): `jspi` runs row walks as fast as `sync` on Chromium and Firefox, where `async` pays 1.2-1.8×, and it interrupts a running statement with no cross-origin isolation. So declaring `jspi` first on the VFS that list `sync` first (`OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS`) would make the default interruptible where the browser has JSPI, at no measured cost. To weigh before deciding: Safari 27 is not measured; the Firefox figure rests on #375's glue, merged upstream and in the pin since 2026-10-05; `transaction-throughput` on `OPFSWriteAheadVFS`/Chromium read 1.27× with a 1.03-1.94× spread (`MemoryVFS` 0.87×), to re-measure; the open path and memory of `jspi` against `sync` are not measured; and a changed default is a consumer-visible change (CHANGELOG, `VFS.md`'s Builds and Recommendations, the `build` JSDoc — `mem:lessons/claims-and-docs`, "A changed default is described in more places than the spec lists").

## One CI per release commit instead of several — to examine (user, 2026-10-06)

A release runs the same commit through the tests up to three times: the `pre-push` hook (`pnpm test`) once per `git push` — pushing `main` and the tag in one command already brings that to one (`mem:conventions`, Releasing) — then `ci.yaml` on the `main` push and `ci.yaml` again as the release's `verify` (`workflow_call`) on the tag, since GitHub raises one `push` event per ref. The user keeps the workflows as they are for now and has a workflow idea of their own. Options discussed on 2026-10-06, none measured: a `guard` job in `ci.yaml` that skips the branch run when `git ls-remote --tags` shows a `v*` tag on `github.sha`, with `git push --atomic` so the tag lands before the events fire; or skipping on a `chore(release):` commit message (a convention, and `main` stays unchecked if the tag never follows). Whether a branch and a tag pushed together really give two runs was not tested on this repo.

## Params as an object, bound by name — not designed (user, 2026-10-09)

`db.read('SELECT … WHERE id = :id', { id: 1 })`: an object as params, today refused with `INVALID_VALUE`. The worker would bind by name — for each statement, `sqlite3_bind_parameter_name(stmt, i)` looked up in the object, a key `id` matching `:id`, `@id` and `$id` (and SQLite reads `#id` too) — because SQLite numbers named parameters per statement in order of first appearance, so no client-side translation to indexes can work across a multi-statement string. Gains for the string form: multi-statement strings bind correctly, and a missing key can throw instead of binding `NULL`. Open: what an extra key does (ignored, or refused once every statement ran), and refusing a positional `?` in a named query; the name→index map could live with the cached statement — measure the lookup. Touches the worker and the protocol, so the full matrix. The `sql` tag does not need it: it uses numbered `?N` (spec 2026-10-08, D11, kept for D14). Positional `?` across statements already binds correctly since `fix/multi-statement-params` (2026-10-09).

## More `types` values for `bulkWrite()` — not designed (user, 2026-10-06)

`types` accepts only `'JSONB'` (spec 2026-10-06, D7). The user sees it later carrying conversions such as `string → number`.

## Notes, with nothing to fix

In `mem:follow-ups/notes`.
