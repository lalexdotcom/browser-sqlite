# Measurements — the library's own suite across browsers: Vitest + WebdriverIO, stock Chrome, Firefox and Safari

Part of `mem:measurements/test-browsers`, split from it on 2026-10-22 when it reached 39 255 characters; the text moved unchanged, and SAFARI-LIB-SUITE moved here from `mem:measurements/ci-runners`. The rules of `mem:measurements` apply.

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

**Safari 27.0.1 re-measured (2026-10-21, the user's Mac, raw harness `spike/idb` served from this container on `localhost:8765`, a manual page, 15 s per stall, cells stop at 3):** busy terminate 3 stalled in 9 rounds, delete pattern 3/52, pool-close pattern 3/45, rw+ro at once 3/3 all **wedged** (open ok, write and read timeout); controls `busy-wait-complete` 0/40 and idle 0/40. WebKit 324094 RESOLVED FIXED (321564@main, 2026-09-21), never reopened; follow-ups 325521 (323066@main) and 327323 (323686@main, 2026-10-13); no stable Safari release note found naming it.

## SAFARI-LIB-SUITE — the library's whole suite on Safari through the planner, 2026-10-22, `macos-26` (Safari 26.6.2) / `xcode-27` (Safari 27.0.1), branch `feat/safari-suite`

**Method.** `tests-macos-26.yaml` / `tests-macos-27.yaml` dispatched with `browsers: safari` alone (temporary on the branch): `pnpm test --browser safari` (unit + Safari's two modes, complement), then `test-parallel.ts --project "conformance safari"`. Safari jobs one at a time (`runPool`'s serial key), 2 processes (3 cores). Final runs 39763455502 (26) and 39763458751 (27), at `de1bddf`.

| | macOS 26, Safari 26.6.2 | macOS 27, Safari 27.0.1 |
|---|---|---|
| plan | 7 cells: start `OPFSWriteAheadVFS/sync`, `OPFSAdaptiveVFS/async`; complement `IDBBatchAtomicVFS/async`, `OPFSCoopSyncVFS/sync`, `AccessHandlePoolVFS/sync`, `MemoryVFS/sync`; isolated `OPFSWriteAheadVFS/sync` | 8 cells: the same with `jspi` for Adaptive and IDBBatchAtomic, plus `OPFSWriteAheadVFS/async` (1 test) |
| Not applicable | safari 7, isolated safari 1 | safari 7, isolated safari 1 |
| merged report (unit included) | 1892 passed / 295 skipped / **7 failed** | 1894 / 297 / **7 failed** |
| reasoned skips | `abandon-gc` ×4 only | `abandon-gc` ×4 only |
| cells | 13-443 s; `OPFSAdaptiveVFS/async` 357-443 s, the longest | 8-152 s |
| conformance safari | 70 passed / 27 skipped, 28 s | 79 / 18, 28 s |

**The failures, every one a killed worker and its file** (both runs, unless said): `OPFSWriteAheadVFS/sync` — `lifecycle` "restarts the slot once and keeps serving" (`WORKER_CRASHED: unable to open database file: InvalidStateError`), `lifecycle` "fails the client permanently once the restart budget is spent" (replacement not ready in 5 s; on 26 on `OPFSAdaptiveVFS/async` instead in the final run), `debug` "keeps the requests of a killed worker", `long-query` "is presumed dead when it never answers the stop request" (on 26 in one run of two), `second-client` "fails the client with that worker's error rather than hanging" (`'still waiting'`); `AccessHandlePoolVFS/sync` — `delete` "deletes a database whose worker was killed mid-statement" (`WORKER_CRASHED: InvalidStateError`), `vfs-create-retry` "opens once the held file is let go" (`InvalidStateError`). Two `OPFSWriteAheadVFS/sync` files also fail their wipe: `.wa-sqlite` and `.wa` `NoModificationAllowedError`. Unchanged across two runs per OS. What follows from them: `mem:follow-ups/safari-suite`.

**The three browsers together** (`browsers: chrome,firefox,safari` restored, runs 39765454826 on 26 and 39765458756 on 27, at `2ec8156`): every Chrome and Firefox job green, Not applicable chrome 21 / isolated chrome 15 / firefox 11 / isolated firefox 5 (Linux's), reasoned skips `abandon-gc` ×4; Safari the same 7 failures; `Conformance` skipped behind the red `Test` (accepted). Not applicable on Safari 19/13 (26) and 18/12 (27), against 7/1 when Safari runs alone — tests no Safari pair runs count as dead in a Safari-only run, as not applicable here (my reading, not checked). Plan 23 cells (26) / 24 (27), 2 jobs at a time, Safari's cells queued last:

| | macOS 26 | macOS 27 |
|---|---|---|
| unit + Chrome + Firefox jobs, summed | ≈ 2023 s (Chrome `OPFSWriteAheadVFS/sync` 474 s, `OPFSAdaptiveVFS/jspi` 448 s) | ≈ 1525 s |
| Safari jobs, summed (serial) | ≈ 637 s (`OPFSAdaptiveVFS/async` 331 s) | ≈ 346 s |
| jobs wall clock | 1629 s | 1086 s |
| `Test` step (build, probes, merge included) | 1723 s of the 2400 s bound | 1156 s |
| estimate with Safari's cells first: max(Safari, all / 2) | ≈ 1330 s | ≈ 940 s |

On these figures `runPool` takes a free Safari job before any other since the end of the branch (user, 2026-10-22); not re-run on GitHub (user: the next runs will show it).

**Found on the way, in the wiring** (fixed on the branch): one `safaridriver` per Node process — WebdriverIO kills it at session end but the `safaridriver` package keeps it as its instance and refuses a second start ("There is already a Safaridriver instance running on port …"), so the planner's second Safari probe failed on both OS (runs 39759771424, 39759776694, 39760717396); and a `safaridriver` started from a missing path has no pid on macOS (posix_spawn fails before any fork), so the package's `kill()` signalled the unit job's process group (`exit 143`, no blob, runs 39761649148, 39761652893).
