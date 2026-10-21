# Measurements — test harnesses across browsers and CI runners: wa-sqlite's suite (Discussion #373), then the library's own (LIB-VITEST-SPIKE)

Part of `mem:measurements`, which indexes every entry; its rules apply here. The first three entries were moved here verbatim from `mem:measurements/wa-sqlite-prs` on 2026-10-08.

## STOCK-BROWSERS — wa-sqlite's whole suite on stock browsers through WebDriver, 2026-10-07/08, GitHub Actions, wa-sqlite `96d91182`

**Method.** A throwaway branch `probe/stock-browsers` on the fork (`lalexdotcom/wa-sqlite`, head `437e6de1`), off upstream `master`. `@web/test-runner` 0.20.2 with `@web/test-runner-webdriver` 0.9.0 (WebdriverIO 9; the 1.0.0 launchers need `@web/test-runner-core` 1.x) for stock browsers, and `@web/test-runner-playwright` 1.0.0 + Playwright 1.63.0 WebKit in `launchPersistentContext`; `WTR_BROWSERS` picks them. Checked-in WASM, no `make`. Quick versions of the harness adaptations agreed in #373: `vfs_read_freshness` and `sql_0005` on `OPFSWriteAheadVFS` skipped without `FileSystemSyncAccessHandle.prototype.mode`, `vfs_open_last_error` accepting `InvalidStateError`, `sql_0005` registering cleanup before the open, `TestContext.create()` rejecting when the worker posts an error, `destroy()` closing the VFS (bounded 2 s) before `terminate()`. Node 22. A probe test logs the user agent, JSPI, `mode`, OPFS, `createWritable`, Web Locks.

| runner | browser | runs | result |
|---|---|---|---|
| `ubuntu-latest` | Chrome 154, chromedriver | 7 | all green, 6157 passed (6156 + the probe), 137-181 s |
| `windows-latest` | Chrome 154 | 3 | all green, 6157, 248-290 s |
| `ubuntu-latest` | Firefox 157, geckodriver | 8 | 7 green (6142, 172-237 s); 1 lost two files at the launcher ("unable to create and start a test page after 60000ms" on `AccessHandlePoolVFS`, "browser disconnected" on `IDBBatchAtomicVFS`), no test failed; not seen again in 5 repeats with WebdriverIO's logs collected |
| `windows-latest` | Firefox 156 | 1 complete, one runner invocation per file bounded at 10 min | 16/16 files green, 6142; ~20 min of tests: `sql` 478 s (`sql_0005` 80 s per build on `OPFSAnyContextVFS`, 42 on `OPFSAdaptiveVFS`), `api` 317 s, `OPFSCoopSyncVFS` 212 s (`vfs_handover` 22-32 s per spec). An earlier whole-suite run cancelled at 12/16 files after ~16 min was this slowness, not a hang |
| `ubuntu-latest` | WebKit 26.6, Playwright, persistent | 3 | 2 green (6142, 212 s); the third stuck in `apt` during `playwright install --with-deps` before any test (actions/runner-images#14594, #14823) |
| `windows-latest` | WebKit 26.6, Playwright | 1 | `getDirectory()` and `createWritable` work, `createSyncAccessHandle()` fails `NotSupportedError: Backend does not support this operation`: 679 failures in 10 files, then a stall. WebKit source: `SharedFileHandle::create` exists only for `USE(UNIX_DOMAIN_SOCKETS)` and Cocoa, `nullopt` elsewhere |
| `xcode-27` (macOS 27.0) | Safari 27.0, safaridriver | 4 (2 whole suites) | all green, 6142, 188 and 219 s |
| `macos-26` | Safari 26.6.2 | | SAFARI26-DATAVIEW-RACE, SAFARI26-IDBMIRROR-KILL, SAFARI-IDB-STRAND |
| `macos-26` | Safari iOS 26.5, simulator | | IOS-SIMULATOR |

**Capabilities read by the probe test.** JSPI present on Chrome 154 with no flag, Firefox 156/157, Safari 27.0 and Playwright's WebKit 26.6; absent on Safari 26.6.2 and iOS 26.5. `mode` (`readwrite-unsafe`) on Chrome only. Sync access handles everywhere but WebKit on Windows.

**Setup facts.**
- **WebdriverIO cannot download geckodriver on Windows under Yarn PnP.** The `geckodriver` package (6.1.1, and 7.0.0) writes the Windows `.zip` entry with `writeFile(path, content.stream())`; Yarn's patched `fs` rejects the `ReadableStream` (`ERR_INVALID_ARG_TYPE`) — [yarnpkg/berry#6580](https://github.com/yarnpkg/berry/issues/6580), open since 2024-10. Linux uses the tar path and works. Worked around with `'wdio:geckodriverOptions': { binary }` set to the runner's geckodriver, found with `command -v geckodriver` (`$GECKOWEBDRIVER` read empty from bash).
- **`EBADF: bad file descriptor, fstat` at Node start, in Yarn PnP's ESM loader, on `macos-26`**, 3 runs of 3, with the image's cached Node 22.23.2; gone with `setup-node`'s `check-latest: true` (22.23.3) — [yarnpkg/berry#7211](https://github.com/yarnpkg/berry/issues/7211) (open), family of #7140.
- `Safari --version` launches Safari and blocks; read `CFBundleShortVersionString` from its `Info.plist`.
- MiniBrowser (WebKitGTK) under WebDriver always runs ephemeral: `--automation` takes `webkit_web_context_get_network_session_for_automation()`, which is `webkit_network_session_new_ephemeral()` (read in WebKit's source, not run). WebKitGTK 2.52.6 on Ubuntu 24.04, 2.54.0 on Debian 13.

## SAFARI26-DATAVIEW-RACE — a harness race only Safari 26 shows, 2026-10-08, `macos-26`, Safari 26.6.2

**Before.** Two whole suites: 72 and 81 failures, all in `vfs_xOpen`/`vfs_xClose` (plus one `vfs_xUnlock`), on every VFS including `MemoryVFS`, reading 0 (`Expected 0 to equal 6`, `… 262`); the count changed between runs.

**Cause.** `test-worker.js` hands the VFS a `Comlink.proxy()` of the output `DataView`; the VFS's `setInt32()` is a message on the proxy's port that nothing awaits, while the call's result returns on Comlink's main port. HTML spec: each `MessagePort` has its own task source (its port message queue), the event loop picks a task queue "in an implementation-defined manner", and the "unshipped port message queue" keeps order only across ports never transferred — a transfer marks both ends as shipped. Both page-side ports here are shipped. The harness relied on an order the spec does not give.

**Fix** (`68aae811` on the fork). The worker gives the VFS a local `DataView` for `jOpen` (arg 3), `jAccess` (2), `jFileSize` (1) and `jCheckReservedLock` (1) and copies it back, awaited, before replying — what it already did for `jRead`'s buffer. **After: 0 failures, 3 suites of 3.** Chrome, Firefox and Safari 27 never showed the race.

## SAFARI26-IDBMIRROR-KILL — Safari 26 kills the page in `sql_0005` on `IDBMirrorVFS`, 2026-10-08, `macos-26`, Safari 26.6.2

**Symptom.** After the race fix, 3 suites of 3 lose `sql.test.js` at the start of `IDBMirrorVFS asyncify sql_0005` ("browser disconnected", `invalid session id`); 5 of 5 with the file alone. No crash report. `IDBMirrorVFS` runs only `asyncify` there (no JSPI). Every other VFS passes `sql_0005` on Safari 26, `IDBBatchAtomicVFS` included.

**WebKit's unified log** (`log show`, WebKit subsystems): WebContent footprint 1006 MB → 4255 → 7933 → 9271 MB in about 2.5 min; at 1640 MB, `bmalloc` 1989 MB against a 3 MB JS heap; `Too many messages (129 … 265787) in the queue to remote PID: 0 (most common: … NetworkConnectionToWebProcess_TakeAllMessagesForPortReply)` every 20 s; then `Unable to shrink memory footprint of process (9263 MB) below the kill thresold (8192 MB). Killed` and `processDidTerminateOrFailedToLaunch: reason=ExceededMemoryLimit`.

**Worker counters** (reported every 2 s through the test server). One worker sits in `jFileControl` (commit) with its 5 IndexedDB `put`/`delete` pending 2.3 → 8.3 s while holding `hint`, `reserved` and `write`; later another sits in `jLock(RESERVED)` with a `getAll` pending 17-47 s; the six others poll `ifAvailable` locks 5-7 times a second, 99 % refused. 2-3 broadcasts in 90 s. Safari 27, same counters: ~224 commits in 15 s, the spec passes in 15.5 s.

| arm, Safari 26, `sql_0005` on `IDBMirrorVFS` alone | result |
|---|---|
| as is (one `Comlink.proxy` callback per attempt) | killed |
| one callback proxy per connection (16 in all) | killed at 9610 MB |
| 1-5 ms pause between attempts | killed at 8892 MB |
| 50-100 ms pause (page sends ~3000 port messages in 2 min; IPC queue still 265787) | killed, 2 of 2 |
| `BroadcastChannel.postMessage` a no-op | killed |
| no `BroadcastChannel` object at all | killed, 2 of 2 |
| Safari 27.0, as is | passes, 2 of 2 |

**Safari iOS 26.5** (simulator, `macos-26`): the same spec fails at Jasmine's 5-minute timeout (300 and 575 s), then `sql.test.js` reaches the runner's 20-minute limit; its log was not collected.

**Not found:** the mechanism inside WebKit, and what in `IDBMirrorVFS`'s use of the APIs triggers it (left: the per-transaction shared lock names and the `navigator.locks.query()` of each commit). The search was stopped there; the decision (user, 2026-10-08) is to skip that one spec on Safari before 27 with `pending()` and its reason.

## IOS-SIMULATOR — Safari in the iOS simulator through safaridriver, 2026-10-08, GitHub's macOS images

Capabilities: `platformName: 'iOS'`, `browserName: 'safari'`, `'safari:useSimulator': true`, `'safari:deviceUDID'` of a simulator booted by the job (`simctl boot` + `bootstatus`; the first boot spends minutes on "Waiting on Data Migration").

- **`macos-26`, iOS 26.5 (iPhone 17 Pro): works**, after three things. (1) `xcrun simctl spawn <udid> defaults write com.apple.webinspectord RemoteAutomationEnabled -bool YES` — the key SafariServices' `_SFAutomationController` reads, in that suite; also written to `com.apple.mobilesafari`. Without it: "Could not find any session hosts that match the requested capabilities". (2) Safari launched once in the simulator (`simctl launch`, 30 s) — without it: "Finding or launching a compatible remote Safari and waiting for its RWIApplication to appear" timed out. (3) `browserStartTimeout` 300 s. Then OPFS works, no JSPI, the suite takes 1923 s with the Safari 26 failures above.
- **`xcode-27`, iOS 27.0: refused.** Only the iOS 27.0 runtime is installed (the README's "Simulator - iOS 27.1/27.2" rows are SDKs; Xcode 27.2 is a beta, `27B5019j`). Xcode 27 ships no `Simulator.app` (Device Hub, `com.apple.dt.Devices`, callstackincubator/rock#730). With the preference written, Safari warmed and Device Hub open, safaridriver 27.0 answers "Could not find any session hosts that match the requested capabilities" with `useSimulator`, and "Some devices were found, but could not be used:" with an empty list without it. No report of it found; arugula-salad/arugula#593 is the nearest. Not tried: image `20261006` (Safari 27.0.1).

## WEBKIT-IDB-TERMINATE — a worker terminated with IndexedDB writes in flight strands its database, 2026-10-05, Playwright WebKit (this container) and the user's Safari 27.0.1 / Chrome 152 (macOS)

**Found as** the intermittent hang of wa-sqlite's `IDBBatchAtomicVFS.test.js` on WebKit (WA-WEBKIT-SUITE). A spec reporter plus `maybeReset` logging showed it: the next spec's `beforeEach` `context.create()` (with `reset`) calls `indexedDB.deleteDatabase('demo')`, which fires `blocked` and never completes — the previous spec's worker was `terminate()`d without closing the VFS, and WebKit never released its connection. Nothing in the harness handles `onblocked`, so the worker never posts its port.

**In the harness**, Playwright 1.63.0 WebKit 26.6, `IDBBatchAtomicVFS.test.js` alone, runs alternated: `TestContext.destroy()` awaiting `proxy.vfs.close()` before `terminate()` **0 hung in 20** (138 passed each, 3-4 s); `terminate()` alone (upstream) **8 hung in 20**, each a `deleteDatabase` `blocked` and still pending at 60 s. Fisher p ≈ 0.003.

**Timing grid in a real Safari** (a page served from this container on `localhost:8765`, a worker that opens a fresh database and writes, the page terminates it then deletes the database; 100 rounds per cell, 5 s then 30 s more on a stall, one database per cell): Safari 27.0.1 passes every `idle` cell and every `busy` cell with the worker terminated at once (100/100, ≤ 10 ms); **`busy` with the worker 50 ms old stalls within 0-5 rounds at every delay (0, 1, 10, 100 ms)**, still pending 35 s later, `blocked` fired or not. Single-cell reruns with a 20-round `idle` control before and after: stalled at round 2, 0 and 1 in three launches (fresh Safari, after ⌘Q, previous tab left open); every control 20/20 — the stall is per database, not the tab's IndexedDB. Chrome 152 (macOS), same grid: 1600/1600, worst 134 ms. Safari preloads the typed URL, so each launch arrived twice; only the completed one counts.

**Minimal reproduction** (one HTML file, blob worker: open a database named after the worker, a loop of one-`put` readwrite transactions, page waits 50 ms, `terminate()`, `deleteDatabase`, 10 s limit, 20 rounds; `?close=1` control: the worker lets its last transaction complete and closes before `terminate()`): **Safari 27.0.1 FAIL at round 1, control PASS 20/20.** Same script, 5 launches each: Playwright 1.63.0 `webkit-2359` **FAIL 5/5**, control PASS 5/5; Playwright `1.64.0-alpha-2026-10-05` `webkit-2370` (rolled 2026-10-02) **PASS 5/5**, control PASS 5/5.

**The library's own paths, not reproduced.** Read 2026-10-05: `close()` sends `close` (the worker finalizes and runs `sqlite3.close`, it never calls the VFS's `close()`, so the IndexedDB connection stays open but idle) then `terminate()`s; `failClient`, `handleDeath` (open timeout, poisoned worker after a failed rollback), `retireSlot` and the `deleteDatabase` worker terminate without closing. Measured with `dist/` in a page on Playwright 1.63 `webkit-2359` (which has the defect), persistent context, `IDBBatchAtomicVFS` and `IDBMirrorVFS`, 10 rounds each, then a new client on the same name must write and read within 10 s: leaving the page while a loop of `db.write` runs **10/10 ok per VFS**; the same after `db.close()` 10/10; `close()` with `drainTimeout: 100` during a transaction writing in a loop 10/10. Not measured on Safari 27, where the raw reproduction fails sooner (round 0-2 against about one launch in two on `webkit-2359`).

**Already reported and fixed upstream:** [WebKit 324094](https://bugs.webkit.org/show_bug.cgi?id=324094) (filed 2026-09-13, fixed by 321564@main on 2026-09-22): `IDBDatabase::stop()` withheld `databaseConnectionClosed` while a transaction was committing, so the server kept the dying context's connection for ever; the fix closes it unconditionally. Its report says one readwrite loop alone gives 0/200 and needs a concurrent readonly; our reproduction stalls with one readwrite loop, and the fixed build passes it — same mechanism, wider trigger than reported. Not in Safari 27.0.1. A standalone probe of this on Playwright's Linux WebKit also crashed the page in most launches (often within 25 rounds); [WebKit 325930](https://bugs.webkit.org/show_bug.cgi?id=325930) (the WPT test of the fix crashing on WPE, a thread-affinity assertion in `TransactionOperation`) is probably the same family — not verified.

## WA-WEBKIT-SUITE — wa-sqlite's suite on Playwright's WebKit, 2026-10-05, GitHub Actions (ubuntu x86_64) and this container (aarch64), wa-sqlite `7fcc30df`

**OPFS by Playwright version and context** (dedicated worker on `http://localhost`, identical in CI and here): Playwright 1.62.1 (WebKit 26.5) has **no `navigator.storage` in any context** — what the 2026-08-24 capability row recorded, a version fact, not a Linux-port fact. Playwright 1.63.0 (WebKit 26.6): ephemeral `browser.newContext()` → `getDirectory()` rejects `UnknownError` (Playwright's docs: "OPFS is currently not supported in ephemeral WebKit contexts"); **persistent `launchPersistentContext()` → sync handles, `createWritable` and Web Locks all work**. No `readwrite-unsafe` (`'mode' in FileSystemSyncAccessHandle.prototype` false); a second handle on a held file → `InvalidStateError` at once. `WebAssembly.Suspending`/`promising` present. The fix is microsoft/playwright#41984 (WebKit r2339, shipped in 1.63.0). Safari 27.0.1 (user's Mac): the same OPFS answers, JSPI present.

**The suite**, `@web/test-runner-playwright` 1.0.0 with `createBrowserContext: () => webkit.launchPersistentContext(<fresh temp dir>)` — the launcher's default is `browser.newContext()` — one file per job: `api` 3950, `WriteAheadCheckpointPlan` 565, `callbacks` 218, `WebLocksMixin` 123, `OPFSAnyContextVFS` 120, `AccessHandlePoolVFS` 108, `MemoryVFS` 99, `IDBMirrorVFS` 72, `OPFSAdaptiveVFS` 70, `MemoryAsyncVFS` 66, `sqlite-api-open` 4, all green, every build including `jspi`. Failing: `OPFSCoopSyncVFS` `vfs_open_last_error` ×3 (ours, #357: expects `NoModificationAllowedError`, WebKit throws `InvalidStateError`); `OPFSWriteAheadVFS` `vfs_read_freshness` ×3 (ours, #365: two connections, impossible without `readwrite-unsafe`, as on Firefox). **Hangs:** `sql.test.js` 2/2 in CI and on the first local run — `sql_0005` on `OPFSWriteAheadVFS` fails its second open (`InvalidStateError`), then `sql_0004`'s reset retries for 10 s and rejects `AbortError`, the WA-FIREFOX-SQL-HANG mechanism exactly; `IDBBatchAtomicVFS.test.js` 1 in 2 in CI, 1 in 6 then 8 in 20 here — WEBKIT-IDB-TERMINATE. Installing here: `playwright install webkit` with `PLAYWRIGHT_SKIP_BROWSER_GC=1` (keeps 1.62.1's browsers) and `sudo … install-deps webkit` once (Debian 13 aarch64 is supported).

## WA-FIREFOX-SQL-HANG — why wa-sqlite's `sql.test.js` hangs on Firefox, 2026-10-03, Playwright 1.62.1 Firefox, wa-sqlite `7fcc30df`, this container

**Per configuration** (a copy of `sql.test.js` with `CONFIGS` cut to one entry, 3 runs, 180 s cap): the nine others pass in 2-8 s, 27 of 27; `OPFSWriteAheadVFS` hits the cap 3 of 3. **Per spec and build** (`OPFSWriteAheadVFS` only): `sql_0001`-`sql_0004` pass on default, asyncify and jspi; `sql_0005` alone fails in 1-2 s, `unable to open database file` at its second `open_v2`. **Combinations** (60 s runner cap): one build, all five specs: finishes (17 passed, 1 failed); two builds without `sql_0005`: finishes (34); two builds, all five, or `sql_0005` alone on two builds: hang; `sql_0005` then other specs on the next build: finished in the order drawn. **Falsifiers:** `sql_0005` with each worker's destroy registered before its open: no hang, both builds fail fast at the open; each step bounded at 5 s: the step that fails is the following suite's `beforeAll` `context.create()` (with `reset`). Mechanism and the harness lines involved: `mem:follow-ups`.


## PW-OPFS-QUOTA — OPFS space in Playwright's ephemeral and persistent contexts, 2026-10-10, this container

**Method.** Playwright 1.62.1 (`chromium-1234`, `firefox-1538`), headless, a page on `http://localhost`: `navigator.storage.estimate()`, then one `createWritable()` writing 64 MB chunks up to a 2 GB cap, the file removed afterwards. Ephemeral = `browser.newContext()`, the default of `@web/test-runner-playwright`; persistent = `launchPersistentContext()` on a fresh directory. n=1 per cell; about 5 GB of RAM were available.

| context | `estimate().quota` | written |
|---|---|---|
| Chromium ephemeral | 10 240 MB | 1 984 MB, then `QuotaExceededError` |
| Chromium persistent | 10 240 MB | 2 048 MB (the cap), no error |
| Firefox ephemeral and persistent | 4 822 MB | 2 048 MB (the cap), no error |

**Reading.** Chromium's ephemeral context announces a quota it does not grant — a masked figure, so that an off-the-record profile cannot be told apart (the user's point; the figure is read, the reason not checked in Chromium's source). Only a write measures space. The limit is the off-the-record context's, not Playwright's patches: a persistent context lifts it, and WebKit needs one anyway for OPFS (WA-WEBKIT-SUITE). Not measured: whether the ~2 GB depends on RAM, WebKit, stock browsers, anything past 2 GB. Kept out of the 2026-10-10 reply on #373 as a weak argument.

## LIB-VITEST-SPIKE — the library's browser tests on stock Chrome and Firefox through WebDriver, 2026-10-09, this container (Debian 13 aarch64)

**Method.** Throwaway branch `spike/vitest-webdriverio` off `main` at rc.10. Vitest 5.0.3 + `@vitest/browser-webdriverio` 5.0.0 + webdriverio 10.0.2 + Vite 8.3.4. The library is the rslib build: `rslib.test.config.ts` imports `rslib.config.ts`, moves every `distPath` from `./dist` to `./tests/build`, and adds a separate `lib` item (a clone of `index`'s, `dts: false`, no `copy`) for `tests/testing.ts`, which re-exports `src/index` plus `createLogger` and `createPoolWorker`. `vitest.config.ts` aliases `browser-sqlite` → `tests/build/index.js` and `browser-sqlite/testing` → `tests/build/testing.js`, injects the target through `define`, and has two projects, `plain` and `isolated` (COOP/COEP through `server.headers`). Ported unchanged except imports: `queries`, `concurrency`, `idb-long-read`, `pool-death` (white-box, from `browser-sqlite/testing`), `isolated/abort-slot`, `isolated/environment`, plus a probe. Target `OPFSWriteAheadVFS/sync`.

| browser (pinned) | result | wall clock |
|---|---|---|
| Chrome for Testing 153.0.8010.52, linux-arm64 | 41/41 | 21 s |
| Firefox 155.0.1, Mozilla linux-aarch64 | 41/41 | 23 s |
| also green on the way: Chrome 155.0.8059.39, Firefox Nightly 160.0a1, 156.0, 157.0.1 | 40/40 each | 18-30 s |

- **The build:** `tests/build/index.js`, `worker/worker.js` and the three `.wasm` byte-identical to `dist/`; no `testing.*` in `dist/`; ~9 s.
- **Falsifier:** a `throw` at the TOP of `tests/build/index.js` fails `queries`, in `testing.js` fails `pool-death`. Appended at the end it does nothing — the bundles end with `//# sourceMappingURL=…` and no newline, so the `throw` lands in the comment (the first attempt read "passes" for that reason).
- **Same tests as rstest:** rstest runs 33 (`chromium`) + 7 (`isolated`) on the same files and target, none skipped — Vitest runs the same 40.
- **Probe** (in the page, an iframe of Vitest's orchestrator): `HeadlessChrome/153.0.0.0` and `Firefox/155.0`; JSPI, OPFS, Web Locks present on both; `crossOriginIsolated` true in `isolated` on both — the first run of the isolated tests on Firefox.
- **WebdriverIO 9.32.0 cannot get Chrome on linux-arm64:** its `@puppeteer/browsers` 2.13.2 stores the download as `linux_arm-<v>` but fetches `chrome-linux64` (x86-64), and chromedriver never starts ("Unable to connect … browser driver"). `@puppeteer/browsers` 3.x (webdriverio 10's) maps `linux_arm` to `linux-arm64` from 153.0.8001.0 on. The provider was built against `@wdio/types` 9 and works with 10.
- **Firefox needs a channel prefix:** no `browserVersion`, `latest` or a bare `156.0` gives a Nightly or "Couldn't find a matching firefox browser for tag "156.0" on platform "linux_arm""; `stable_155.0.1` gives the release.
- **Vitest renames `instances` in place:** two projects sharing one `instances` array fail at startup ("project name "plain (chrome)" was already defined").
- `cacheDir` in the provider options keeps the downloads in `node_modules/.cache/wdio` instead of `/tmp`.
- **Not run:** Safari, Windows, macOS, the rest of the suite, the matrix of targets.

## LIB-WIN-MAC — the library's suites on GitHub's Windows and macOS runners, 2026-10-14/15, Chrome 153 / Firefox 155 (`ci/windows-macos`)

**Method.** `tests-windows.yaml` / `tests-macos.yaml` → `tests.yaml` (`pnpm build`, `pnpm test`, `pnpm test:conformance`), `windows-latest` (4 vCPU, 3 jobs) and `macos-latest` (arm64, 2 jobs). Windows with `BSQ_TIME_SCALE=4` and a 240-min job from run 38598783823 on.

| | `pnpm test` | conformance | counts |
|---|---|---|---|
| macOS, green runs 38592188039, 38595129721, 38598783776, 38693552150, 38715791686, 38721500086, 38726538338, 38734843269 | 276-949 s (runner variance) | 36-93 s | 343 files, 2506-2510 passed / 490 skipped (the count grew with the branch's unit tests), Not applicable 20/14/11/5, `abandon-gc` ×4 — Linux's |
| Windows, green runs 38726538222, 38734843259 (attempts 1 and 2) | 1276-1614 s | 179-210 s | 343 files, 2506 passed / 494 skipped (+3 `coopsync-handover` skips on Firefox, +1 POSIX-only unit test), Not applicable 20/14/11/5, conformance 162/32 |

**What Windows needed, in the order the runs showed it:** `shell` only for `pnpm`/`npx` (cmd.exe mangled `node -e`); `/` in the matrix table; the per-job and per-test bounds ×4 (Firefox OPFS tests 7-16× slower than Chrome there — OPFS-PROBE, `mem:follow-ups` § Firefox + OPFS); then the bounds tests write themselves (`scaled()`), the library's default open timeout in tests (`tests/browser/helpers/library.ts`), Vitest's `browser.connectTimeout` (a Firefox cell never connected in 60 s), and double quotes in `package.json` scripts (cmd.exe keeps `'…'`). Product limits met and recorded in `mem:follow-ups`: two `OPFSCoopSyncVFS` clients miss the 30 s open timeout (three tests skipped on Windows Firefox), a single `OPFSWriteAheadVFS` client did once under load, and the held-handle race behind wa-sqlite #381. Chrome on Windows was green from the first run that reached the tests.


## BROWSERS-INSTALLER — `browsers.ts` as the only installer, 2026-10-19 (`build/browsers-installer`)

**Cold cache, this container (Debian 13 aarch64, 16 cores).** `node_modules/.cache/wdio` moved aside, `pnpm test` (6 jobs at a time): green, 2 min 47 s wall, 358 files, 2 703 passed / 506 skipped, Not applicable 20/14/11/5, `abandon-gc` ×4. Each of the four items (`chrome/linux_arm-153.0.8010.52`, `chromedriver/…`, `firefox/linux_arm-stable_155.0.1`, `geckodriver/linux_arm-0.37.1`) logged `installing` exactly once, under two successive elections (the Chrome jobs' leader, then the Firefox jobs'); `policies.json` present, `.staging` empty. `pnpm test:unit` with the cache moved aside: green, no `wdio` folder created.

**Warm path.** `resolveBrowsers(['chrome', 'firefox'])` on a full cache, `performance.now()` around the call: first call in a fresh process 0.71-0.81 ms (5 processes), then 0.10-0.18 ms (calls 2-10 in one process; the first 0.88). No socket is touched.

**GitHub runners.** The setup step's `install` led on macOS through `/var/folders/…/T/bsq-browsers-<hash>.sock` and on Windows through `\\.\pipe\bsq-browsers-<hash>`, each item installed once. Final head `607b39d`: macOS run 39338378269 green (~18 min, 358 files, conformance 6/6, Not applicable 20/14/11/5), Windows run 39338380934 green (~33 min, 358 files, conformance 6/6; its CI cache was already marked, so nothing installed).

**The macOS lock defects (LOCK-MACOS).** The lock's multi-process unit tests failed on macOS only: a throwaway workflow looping `tests/unit/tooling/install-lock.test.ts` failed 12 of 50 runs on `macos-latest` (3 cores; 7 of 25 alone, 5 of 25 under 6 busy loops) and 0 of 50 on `ubuntu-latest`; 32 busy loops on this container's 16 cores reproduced nothing. With each child's timestamped trace: 6 of 40 failed, two causes — `listen()` on a held socket returned `EEXIST` beside `EADDRINUSE` (the process died), and a client the kernel had queued but the leader had not accepted was dropped by `server.close()` without an answer. After `607b39d` (`EEXIST` counts as busy; the leader drains its accept queue until a loop turn passes with no new connection): 0 of 40.

## SAFARI-LIB-SPIKE — the library's Vitest + WebdriverIO suite on Safari through safaridriver, 2026-10-20, GitHub `macos-latest` (macOS 26.6.2, Safari 26.6.2, 3 cores)

**Method.** Throwaway branch `spike/safari` (commits `896c0c3`, `ce106e0`, `bd1df8f`; `mem:follow-ups/safari-idb-stranded` § How to pick it up): Safari projects under `BSQ_SPIKE_SAFARI=1` (headless off, plain `webdriverio` provider with `browserName: 'safari'`), one build, one Vitest process per session with its own Vite cache. Runs 39381370815, 39383576597 (stopped after two scenarios by `bash -e`), 39384117648. `sudo safaridriver --enable` succeeds on the image.

| scenario | result |
|---|---|
| `conformance safari`, one session | 3 files passed, 34-57 s (7 of 8 runs alone; `conformance chrome` 46 s on the same runner) |
| `probe safari`, `probe isolated safari` | pass, 12-17 s; COOP/COEP isolation works under safaridriver |
| two, then four Safari sessions started at once | one session gets Safari; every other fails `Could not create a session: The Safari instance is already paired with another WebDriver session` (after a "Request to pair … timed out" retry) |
| Safari beside `conformance chrome` and `conformance firefox` at once | Safari gets its session; Chrome and Firefox pass (103-111 s, against 46 alone — 3 cores); Safari failed its wipe (below) |
| `probe safari` three times back to back, no quit | 3/3 pass — a clean shutdown frees Safari |
| a Safari run `kill -9`ed after 25 s | `safaridriver` and Safari left running; the next session passes, as after `pkill safaridriver` and after quitting Safari |
| once, right after the four-session failure | a lone Safari session refused (`already paired`); not reproduced since |

**The stranded IndexedDB connection.** 3 runs of 10 failed every file on `IndexedDB "IDBBatchAtomicVFS" (still open after 5000 ms)` in the storage wipe, tests passing: 1 of 8 alone, 2 of 2 with another load on the machine. Diagnosed in SAFARI-IDB-STRAND; what to do: `mem:follow-ups/safari-idb-stranded`.
## SAFARI-IDB-STRAND — what strands an IndexedDB connection on Safari 26, and the library path that does it, 2026-10-20, GitHub `macos-latest` (macOS 26.6.2, Safari 26.6.2, 3 cores), branch `spike/safari`

**Method.** Two instruments on `spike/safari` (runs 39388907167 → 39405514177). (1) `spike/idb/` — a page and a worker in raw IndexedDB driven through safaridriver (`node spike/idb/run.mjs <plan>`): per round the worker opens a fresh database and ends in one way, then the page calls `deleteDatabase` (stalled past 5 s, watched to 30 s); `probe` opens a new connection first and writes and reads. (2) `tests/browser/setup/spike-idb-trace.ts` in `conformance safari`: every `Worker` recorded (name, messages, who called `terminate()`), the worker reporting the IndexedDB transactions still live at its `closed`/`deleted` reply (`src/worker/idb-settle.ts`, a wrapper of `IDBDatabase.prototype.transaction`), and under `VITE_SPIKE_PROBE=1` a probe before each test (an upgrade request to version+1, aborted; `blocked` means a connection is held).

**Raw IndexedDB, Safari 26.6.2** (stalled past 30 s / rounds, cells stop at 3-5 stalls; two or three runs each):

| how the worker ends | stranded |
|---|---|
| `terminate()` in a readwrite loop (any delay 5-500 ms, any durability) | 3/19, 3/16, 2/40; strict 1/20, 0/20; relaxed 0/20, 2/20 |
| `db.close()` without waiting, then reply and `terminate()` | 3/22, 3/31 (most others `blocked` then ok) |
| `self.close()` at once | 3/9, 3/17 |
| **the library's delete worker**: readwrite delete, readonly get awaited on its request only, `close()`, reply, `terminate()` | 3/16, 3/21, 4/37, 2/60, 3/14 |
| **the library's pool `close`**: last write committed, readonly get awaited on its request, no `close()`, reply, `terminate()` | 3/56, 3/42, 3/31 |
| reply on a write's request, not its commit (default, relaxed) | 1/60 each; strict 0/120 |
| readwrite and readonly loops at once, `terminate()` (WebKit 324094 as filed) | 5/34, 3/16, 3/19, 3/18 — **wedged**: open ok, write and read never complete |
| **last transaction's `complete` awaited before `terminate()`** — with or without `close()` (`busy-wait-complete`, `busy-close-after-complete`, `read-await-close`, `delete-pattern-complete`, rw+ro both awaited) | **0** in every cell: 0/80, 0/80, 0/120, 0/120, 0/60 |
| an empty readwrite transaction awaited first (barrier) | 0/240 delete pattern, 0/160 busy, 0/160 rw+ro |
| idle worker; worker killed during `indexedDB.open` | 0/80, 0/80 |

Rule: ending a worker before its last transaction fired `complete`, **readonly included**, can strand the connection. A stranded database stays usable from a new connection (open, write, read ok, 5/5 and 4/4) — only `deleteDatabase` and upgrades stay blocked, through a page reload; a **wedged** one (rw+ro at once) accepts no transaction at all. A new safaridriver session starts with empty storage (a marker database is gone), so whether a stranding survives a tab close or a Safari restart cannot be seen through WebDriver.

**Safari Technology Preview 27.0 (build 21627.1.2.1, `brew install --cask safari-technology-preview` on the same image), same cells:** busy terminate 0/40, delete pattern 0/60 (`blocked` then ok within 32 ms), pool close 0/80, rw+ro 0/40 not wedged — while Safari 26.6.2 beside it: 2/40, 3/14, 3/31, 3/18 wedged. WebKit 324094's fix (321564@main, in STP 254 of 2026-10-08; follow-ups 323066@main and WebKit 327323) removes it; no stable Safari carries it on 2026-10-20.

**In the library's suite.** `conformance safari`, stock: 8 stranded runs of 60 over five rounds (every file of the run then fails the wipe — the stranding outlives the file, not the session). Located (`VITE_SPIKE_PROBE=1`, 1 hit in 14): held after **invariant 7 (`deleteDatabase`) on `IDBBatchAtomicVFS`**; the only worker of that test ended with a live transaction is the delete worker, `recv=deleted idbPending=[readonly]`, terminated 0 ms after its reply — the `jAccess` barrier's readonly transaction (`deleteDatabaseFiles`). Every run's delete reply carries that readonly transaction; once in ~800 replies a pool worker's `closed` carried a readwrite one. No forced path (drain timeout, `handleDeath`, `failClient`) runs in conformance.

**The fix, A/B in the suite** (arms alternated on the same runner, CPU load on half): waiting for every tracked transaction before the `closed`/`deleted` reply (bounded 2 s) **0 stranded in 41 runs** (one run lost to `Browser connection was closed`, no storage error); the barrier variant 0/30; stock beside them 11/70. Fisher: any fix 0/71 vs 11/70, p = 0.0003.

**Cost.** The wait: p50 0 ms, max 2 ms per reply, ≤ 16 ms per file. The tracker per transaction, interleaved blocks of 50 in one worker (3 × 20 pairs): Safari 0.34-1.22 ms per transaction either way, paired ratio 0.93-1.06, tracked slower in 8-12 of 20 — not detectable; Chrome 0.19-0.22 ms, 0.97-1.04. Library level (`spike-perf.test.ts`: 200 writes, 200 point reads, a 20 000-row insert, `close`, `deleteDatabase` on `IDBBatchAtomicVFS` and `IDBMirrorVFS`), rotated arms, paired per round: n=30, tracker and fix vs no wrapper, every median ratio 0.88-1.06, slower/faster 10/15 to 18/12; a second round, n=24, put three arms 10-30 % above `bare` including the barrier arm, which does no per-transaction work there — the runner's noise (one arm's 200 reads ranged 0.7-3.8 s), not a cost. **The barrier is rejected:** `close()` ×150 on `IDBBatchAtomicVFS` (~5 → ~780 ms) and ×2.4 on `IDBMirrorVFS`, 24/24 and 22/22 slower — its readwrite transaction queues behind the other connections' transactions too. An unpaired first look (10 pairs) had shown +42 % on reads: noise.

## SAFARI-IDB-LIB — the library's pair suite and its forced kills on Safari 26's IndexedDB VFS, 2026-10-20, GitHub `macos-latest` (macOS 26.6.2, Safari 26.6.2), branch `spike/safari`

**Method.** `pairs` job: every `tests/browser/pairs/*.test.ts` on `safari · IDBBatchAtomicVFS/async` and `safari · IDBMirrorVFS/async`, **one Vitest process and one Safari session per file** (safaridriver sessions start with empty storage, so a file's own wipe names it), `spike-idb-trace.ts` registered right after the wipe and **before `need-guard.ts`** — `helpers/index.ts` keeps the `Worker` it finds as `NativeWorker`, and the cleanup's `withNativeWorker(deleteDatabase)` bypassed a wrapper installed later (the first `pairs` run, 39408720969, is invalid on that path for that reason). `forced` job: 16 files that kill workers (`abandon-transaction abandon close abort-slot chunk-delivery failed-client interrupt lifecycle long-query open-retry pool-death tx-quiesce query-timeout tx-timeout idb-long-read write-lock-reclaim`), 9 runs each per VFS. `kill` job: `tests/browser/pairs/spike-kill.test.ts` (`VITE_SPIKE_KILL=1`), per round a pool-of-one client writing 4 KiB blobs in a loop, an `ErrorEvent` dispatched on its worker after 20-80 ms (`handleDeath` terminates it), close, then per IndexedDB database a readonly transaction (usable?) and an upgrade probe (held?); the first stranding ends the session; 10 sessions of up to 40 rounds per arm.

| run | IDBBatchAtomicVFS | IDBMirrorVFS |
|---|---|---|
| pairs, stock (39414794510) | **45 of 75 files** strand (cleanup's delete workers) | 0 of 75 (an earlier run: 1, `query-timeout`, a `closed` reply carrying a readwrite — IDBMirrorVFS writes at open) |
| pairs, fix (settle before `closed`/`deleted`) | 0 of 75 | 0 of 75 |
| forced files ×9, fix | 1 of 144 (`lifecycle`) | 0 of 144 |
| kill stress, fix | 7 and 7 sessions of 10 strand; ~7/230 kills (~3 %) | 10 and 8 of 10; ~10/45 kills (~22 %) |
| kill stress, fix + quiesce 300 ms | **0 in 400 kills** | **0 in 400 kills** |
| pairs, fix + quiesce (39433555622) | 0 of 75 | 0 of 75 |

Located (`VITE_SPIKE_PROBE=1`, `lifecycle` ×20, 2 hits): **"reports a slot that opened and then dies during the retry round as lost"** — a worker killed in the microtask after its `ready`. Every stranding by a forced kill read `blocked:ok`: the connection held, the database still usable (no wedge seen, 15/15). Failures that are not IndexedDB, in every arm: `default-build` "falls back to the first declared build" (its premise `typeof WebAssembly.Suspending === 'function'` — Safari 26 has no JSPI); `lifecycle` "fails the client permanently once the restart budget is spent" (replacement not ready within the test's 5 s, 8 of 20 and 3 of 9 runs, both VFS, both arms — Safari's startup time on 3 cores).

**The quiesce** (prototype, `src/pool.ts` + `src/worker/worker.ts` + `src/worker/idb-settle.ts`): the pool's `terminate()` poisons the transport as before, then, unless the worker had answered `closed` (status read before `poison()`), drops `onmessage`, posts `quiesce` and calls the engine's `terminate()` on `quiesced` or after the grace; the worker stops its gate, makes `IDBDatabase.prototype.transaction` throw `InvalidStateError` for any new transaction and waits until none is live (bounded 1 s). The close path keeps its synchronous `terminate()` — the first version deferred it there too and broke close.test.ts "waits for the worker to close the database before terminating it". Chrome: the IndexedDB pairs 150/150 with fix + quiesce. Cost: nothing on the ordinary paths; a forced kill's engine `terminate()` comes up to the grace later (not timed).

**Validation of `fix/safari-idb-stranded` (2026-10-21, runs 39569148800 and 39574613092, the real code, no prototype):** pairs 77 files per VFS, 0 stranded, `default-build` now skipped by `requires:jspi-available`; conformance 24/24; kill stress 0 in 400 kills per VFS; `quiesce.test.ts` 6/6 once its grace test dropped the request instead of `killSilently` + crash (Safari does not deliver an `ErrorEvent` dispatched on a Worker already terminated: the first version timed out there, 2/2).
