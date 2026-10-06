# Follow-ups — the open backlog

One short entry each, and every entry OPEN. **An entry marked DORMANT waits for an event and needs no action until it comes: it is not part of the backlog and is not listed when the user asks for it (user, 2026-10-03).** Anything closed is deleted from here —
`CHANGELOG.md` and `git log` record what was fixed, `mem:measurements` holds the numbers,
`mem:vfs` the VFS behaviour, `mem:lessons` what a closure taught.

**Entries waiting on an event live in `mem:follow-ups/dormant`** — `open-retry` on Firefox and the rstest/Firefox `getDirectory()` hang, moved there on 2026-10-05 to keep this file under 40 000 characters.

**Delete, never annotate.** No struck-through lines, no "shipped and merged", no headstone
saying an entry is gone, no verdict on an entry: what is written here is the backlog, not a
report about it. Each of those was tried, and each made the file's length stop meaning
anything.

**Verify an entry against the source before scheduling work on it.** Entries rot into
descriptions of a problem that has moved or never existed: `wa-sqlite.d.ts` claimed to
shadow types that were never loaded, `W-types` a duplication already gone. Both would have
been work on nothing.

## wa-sqlite #371: `IDBMirrorVFS` commit-abort — OPENED 2026-10-03, waiting on rhashimoto

Offered on #363; rhashimoto: "Yes, please, if you're up for that." Defect: IDBMIRROR-COMMIT-ABORT; designs compared: IDBMIRROR-ABORT-JOURNAL, IDBMIRROR-ABORT-DESIGNS (`mem:measurements`).

**The user chose the reload design (2026-10-03)** after the measured comparison; the first pushed attempt (poison every call, as `OPFSPermutedVFS`) corrupts the store on reopen and was dropped. **The user asked whether to keep history: no PR was open, so the branch was rebuilt from upstream master `7fcc30df`** (which by then had #363, #369, #370 merged); the old local commits were kept on a backup branch, deleted on 2026-10-03. `fix/idb-mirror-commit-abort` = `1844c761` (fix) + `1f7b2533` (tests), force-pushed over the poison commits on the user's go, then **opened as rhashimoto/wa-sqlite#371**; body opens with "This one turned out trickier than I expected 😅" (user). Report `docs/upstream/2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md`.

What the fix does, each part with a test that fails without it (ablation, both engines): writes never fail (a failing batch write makes SQLite fall back to a journal that is later played back); `#commitTx` refuses a transaction built on an aborted view; a gate request (only while another commit is pending) drops commits queued behind the aborted one, since `abort()` throws after `commit()`; reload from IndexedDB at the next SHARED and in the `full` error path (`#loadFile` extracted from `jOpen`); `SQLITE_BUSY` at RESERVED while aborted (transparent with a busy timeout); the journal removed on `jClose` of an aborted file (else reopen stores the aborted rows, 12/12). Dropped after ablation showed no effect: a second check after `#commitTx`'s await, journal removal on reload, a guard in `#processBroadcasts`. Known limit: exclusive `normal` fails commits until reopen.

Evidence: 6 tests red on master both builds both engines; 190 tests 3/3 on Chromium and Firefox; suite 6274 passed; 168-probe matrix clean; perf = master within variation (9 interleaved runs). The test worker waits for pending commits before closing because closing first throws `InvalidStateError` from the broadcast — a separate defect, on master too, sent as #372 (entry below). **Body corrected 2026-10-03 (user):** the cost sentence now says commits confirmed before the connection learns of the abort are lost only in exclusive mode. **Revised the same day on the user's go: `3367cb65` reloads the view at the refusal unless a journal exists (IDBMIRROR-ABORT-RELOAD-ON-REFUSAL), so exclusive `normal` recovers after one `IOERR`; test adjusted (exclusive `normal` continues without reopen), body updated, comment 5971457674 posted; CI green (run 37139391822).** Carried in `patches/` since the repin to `7fcc30df`, merged with #372 since 2026-10-03 (`mem:stack-and-build`). Upstream CI green (runs 37137339446, 37139391822). What each answer calls for: changes → same worktree `.work/wa-sqlite-mirror-abort`, rerun the falsifiers, then rebuild the patch from both heads (the `jClose` conflict with #372 resolved as there); merge → repin.

## wa-sqlite #372: `IDBMirrorVFS` broadcasts a commit that completes after close — opened 2026-10-03, carried

With `synchronous=normal`, closing right after a commit made `oncomplete` post on the channel `jClose` had closed (`InvalidStateError`, uncaught), and — the real defect — the other connections never got the transaction: one that only reads stays on its old view until it writes, whose first attempt gets `SQLITE_BUSY`. Same when the context is terminated right after close (no error then). Fix sent: `jClose` awaits the commits in flight (`File.commitsInFlight`) before closing the channel. Skipping the broadcast once closed silenced the error and kept the stale readers; posting on a fresh channel missed terminated workers (IDBMIRROR-CLOSE-BROADCAST, `mem:measurements`). In this library: a second client stale and `BUSY` on its next write after the first client's `close()`, the error reaching the page on Chromium; gone with the carried patch.

`lalexdotcom:fix/idb-mirror-close-broadcast` = `a9811d75` (fix) + `69e00270` (tests), on `master` `7fcc30df`, **opened as rhashimoto/wa-sqlite#372** on the user's go. Based on master, not on #371, so the maintainer picks the merge order; the body names the conflict with #371 (`File` constructor, `jClose`, end of `#commitTx`) and promises to rebase whichever lands second (user). Carried in `patches/` merged with #371 (`mem:stack-and-build`). Upstream CI green on `69e00270` (run 37147812971). Report `docs/upstream/2026-10-03-wa-sqlite-372-idb-mirror-close-broadcast.md`. What each answer calls for: review changes → worktree `.work/wa-sqlite-close-broadcast`, rerun `test/IDBMirrorVFS.test.js` on both engines; #371 merges first → rebase #372 onto it (resolution: wait for commits in flight, then #371's journal removal) and drop `commitsFinished()` from #371's test worker if wanted; either merge → repin.

## wa-sqlite's suite on Chromium, Firefox and WebKit — PR wanted by rhashimoto (Discussion #373, 2026-10-05)

Upstream CI runs Chromium only, so neither shows there. Seen running the suite on Firefox (Playwright 1.62.1) for #372; both on `master` `7fcc30df`. **Neither is a VFS defect and neither reaches this library**, whose `OPFSWriteAheadVFS` answers a second client with `DATABASE_IN_USE` on Firefox and terminates a worker whose open fails (`mem:vfs`). Numbers: WA-FIREFOX-SQL-HANG, `mem:measurements`.
- **`vfs_read_freshness` on `OPFSWriteAheadVFS`** (default, asyncify, jspi): `unable to open database file` at the second connection. The test is ours (#365) and assumes two connections; on Firefox, without `readwrite-unsafe`, the VFS keeps its access handles for a connection's life.
- **`sql.test.js` hangs, caused by `OPFSWriteAheadVFS`'s `sql_0005`.** Same assumption: its second of eight connections fails to open on Firefox. Then three harness traits make a failure a hang: `sql_0005` registers a worker's cleanup only after a successful open, so the worker whose open failed is never destroyed, and its VFS keeps its `.session-*` directory and temp-file handles; the next `context.create()` with `reset` cannot empty OPFS (`maybeReset` retries `NoModificationAllowedError` for 10 s, then rejects unhandled, so the worker never posts its port); `TestContext.create()` listens for that message only and waits for ever. Jasmine runs in random order (`random: true`, not overridden by `web-test-runner-jasmine`), so the file hangs only when a resetting spec runs after that failure — hence one `master` run that finished.
- **Asked upstream: Discussion rhashimoto/wa-sqlite#373 ("Should the test suite also run on Firefox?", category Ideas), opened 2026-10-03 on the user's go.** It gives the case for Firefox (no `readwrite-unsafe`, as on Safari; #363, #367 and #369 Firefox-only or worse there; JSPI on Firefox; Playwright's WebKit on Linux has no OPFS — false, see below), the two adaptations above, owns `vfs_read_freshness`'s assumption (#365), and offers a PR.
- **rhashimoto answered on 2026-10-04**: not opposed to more diversity, but is Firefox the best choice given its declining usage and finances, and is WebKit's OPFS problem Playwright's private mode, painful to override? **Measured 2026-10-05, both answered** (WA-WEBKIT-SUITE and WEBKIT-IDB-TERMINATE, `mem:measurements/wa-sqlite-prs`): yes, the ephemeral context; one line of config with Playwright 1.63+; the suite on WebKit then needs the Firefox adaptations above plus `vfs_open_last_error` accepting `InvalidStateError`, and `TestContext.destroy()` closing the VFS before `terminate()` (or Playwright 1.64's WebKit, which carries WebKit 324094's fix). The reply proposing WebKit rather than Firefox, with the measurements and a test-only PR offered, was posted on the user's go on 2026-10-05 (discussioncomment-18758564), as a reply to his comment. **rhashimoto answered the same day (16:02 UTC): "Running CI tests on all three browsers by default would be great if you're up for that"**, and asked that testing be easy to restrict to a single browser during development, e.g. with an environment variable. **So the PR is wanted, test-only, not started:** Chromium, Firefox and WebKit by default in the config and the CI workflow; an environment variable to pick one; WebKit in a persistent context (Playwright 1.63+); the Firefox adaptations above (`vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` without `readwrite-unsafe`, and the harness traits that turn a failed open into a hang); for WebKit also `vfs_open_last_error` accepting `InvalidStateError` and `TestContext.destroy()` closing the VFS before `terminate()` (or Playwright 1.64's WebKit). Rerun the whole suite on all three. **Design questions asked before starting** — posted on the user's go on 2026-10-06 as a top-level comment (discussioncomment-18773230), each with our default: (1) which Chromium — upstream CI runs a real Chrome 129 (`browser-actions/setup-chrome` + `chromeLauncher`, bumped from 121 on 2024-09-23 alongside Emscripten 3.1.61, reason not in the commit); options Playwright's bundled Chromium, a real Chrome through Playwright (`channel: 'chrome'` or `executablePath`, the latter "at your own risk" per Playwright's docs), or `chromeLauncher` kept; and whether 129 is a deliberate pin. **Measured 2026-10-06, this container (aarch64):** Playwright 1.63.0 drives Chromium 129.0.6668.29 (Playwright 1.47.2's `chromium-1134`, no branded Chrome exists for Linux arm64) through `playwrightLauncher({ product: 'chromium', launchOptions: { executablePath, args: [<upstream's JSPI flag>] } })`: `WebAssembly.Suspending`/`promising` present, upstream `master` `96d91182`'s whole suite **6156 passed, 0 failed, 102.6 s**. Not tried: the branded x86_64 Chrome 129 from `setup-chrome` (would take a CI probe on the fork). (2) `WTR_BROWSERS`, comma-separated, all three when unset. (3) a matrix, one job per browser, `fail-fast: false`, both passes; to cut CI time, drop the checked-in-WASM pass, never the post-`make` one (the user: a PR can change the WASM build, only the post-build pass tests it). (4) skip `vfs_read_freshness`/`sql_0005` without `mode`; `vfs_open_last_error` accepts both errors. (5) cleanup registered before the open, `create()` rejects on a failed reset. (6) `destroy()` closes the VFS before `terminate()`, or wait for 1.64. (7) one PR, test/harness commits before config/workflow. Waits on his answers. Upstream `master` is `96d91182` (#375 merged); `probe/webkit-opfs` sits on `7fcc30df` and is throwaway. The fork branch `probe/webkit-opfs` holds the CI probe (workflow, `probe/webkit-opfs.mjs`, the WebKit config); the local instrumentation on top of it is uncommitted.

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

**Also its WebKit (2026-10-05):** `webkit-2370` in `1.64.0-alpha-2026-10-05` carries WebKit 324094's fix — a worker terminated with IndexedDB writes in flight no longer strands the database (WEBKIT-IDB-TERMINATE, `mem:measurements/wa-sqlite-prs`). It matters if a WebKit project of ours follows (the rstest entry).

Playwright's Firefox loses the page's content process when a worker is `terminate()`d a few ms after `new Worker(...)` (LIFECYCLE-SEGV, `mem:measurements`). **Already fixed upstream, no issue to open:** it is microsoft/playwright#42565 (a worker torn down while its script compiles, a regression of 1.62.0's `firefox-1538`), fixed by the Gecko patch rolled in #42631 (`r1544`, 2026-09-09). Checked 2026-10-03 with a one-spec reproduction (`about:blank`, two blob workers terminated 0-6 ms after creation, 150 rounds): Playwright 1.63.0 (`firefox-1543`, Firefox 155.0) 5/5 `Target crashed`, and its binary launched alone 10/10, against Mozilla's Firefox 155.0 10/10 clean; `@playwright/test@1.64.0-alpha-2026-10-03` (`firefox-1554`) 10/10 clean on Firefox. **To do when 1.64.0 is released stable** (not an alpha; `npm view playwright dist-tags` → `latest`): bump `playwright` in `package.json` (pinned at 1.62.1), then **make sure the Firefox actually used is the new build**, `firefox-1554` or later:
- locally, `.devcontainer/post-create.sh` installs browsers only when the container is created, so run `pnpm exec playwright install --with-deps chromium firefox` by hand; the old `firefox-1538` stays in `~/.cache/ms-playwright` and is simply no longer chosen;
- check with `node -e "console.log(require('playwright').firefox.executablePath())"` that the path names the new revision and exists, and that rstest runs on it (the browser provider uses the project's `playwright`);
- in CI the browser cache is keyed on `pnpm-lock.yaml` (`ci.yaml`, `release-and-publish.yaml`), so the bump renews it by itself;
- then rerun the Firefox config, and the one-spec reproduction above if in doubt;
- **and remeasure the rstest/Firefox `getDirectory()` hang** (its entry in `mem:follow-ups/dormant`: what each result calls for is there). The test-side guard in `lifecycle.test.ts` (kill a silent worker only after its boot signal) stays either way. The `DOM Worker` thread leak of the same builds (WORKER-LEAK) was not re-measured on `firefox-1554`; it never reaches the 512-worker cap in the suite.


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

## `jspi` before `sync` in the build order — to examine (user, 2026-10-05)

Measured on 2026-10-05 (JSPI-VS-SYNC, `mem:measurements/statement-cache-and-perf`): `jspi` runs row walks as fast as `sync` on Chromium and Firefox, where `async` pays 1.2-1.8×, and it interrupts a running statement with no cross-origin isolation. So declaring `jspi` first on the VFS that list `sync` first (`OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS`) would make the default interruptible where the browser has JSPI, at no measured cost. To weigh before deciding: Safari 27 is not measured; the Firefox figure rests on #375's glue, merged upstream and in the pin since 2026-10-05; `transaction-throughput` on `OPFSWriteAheadVFS`/Chromium read 1.27× with a 1.03-1.94× spread (`MemoryVFS` 0.87×), to re-measure; the open path and memory of `jspi` against `sync` are not measured; and a changed default is a consumer-visible change (CHANGELOG, `VFS.md`'s Builds and Recommendations, the `build` JSDoc — `mem:lessons/claims-and-docs`, "A changed default is described in more places than the spec lists").

## One CI per release commit instead of several — to examine (user, 2026-10-06)

A release runs the same commit through the tests up to three times: the `pre-push` hook (`pnpm test`) once per `git push` — pushing `main` and the tag in one command already brings that to one (`mem:conventions`, Releasing) — then `ci.yaml` on the `main` push and `ci.yaml` again as the release's `verify` (`workflow_call`) on the tag, since GitHub raises one `push` event per ref. The user keeps the workflows as they are for now and has a workflow idea of their own. Options discussed on 2026-10-06, none measured: a `guard` job in `ci.yaml` that skips the branch run when `git ls-remote --tags` shows a `v*` tag on `github.sha`, with `git push --atomic` so the tag lands before the events fire; or skipping on a `chore(release):` commit message (a convention, and `main` stays unchecked if the tag never follows). Whether a branch and a tag pushed together really give two runs was not tested on this repo.

## Template queries with JSON parameters — not designed (user, 2026-10-06)

`query()`, `write()` and the other parameterised methods still bind an object as `NULL` and an array as bytes (wa-sqlite's `sqlite3.bind`); `feat/bulk-object-values` fixed it for `bulkWrite()`/`output()` only (spec 2026-10-06, D1). The user's direction: tagged templates, `` sql`SELECT … WHERE id = ${o}` `` serialising objects as JSON text, and a JSONB variant whose form is open — `` sql('jsonb')`…` `` or `` jsonb`…` `` (loses the "SQL" reading), `` jsonbSql`…` `` judged too verbose. The form is settled during that work.

## More `types` values for `bulkWrite()` — not designed (user, 2026-10-06)

`types` accepts only `'JSONB'` (spec 2026-10-06, D7). The user sees it later carrying conversions such as `string → number`.

## Notes, with nothing to fix

In `mem:follow-ups/notes`.
