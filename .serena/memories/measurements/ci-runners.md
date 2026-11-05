# Measurements — the library's suites on CI runners, from macOS 26/27 on (2026-10-21)

Part of `mem:measurements`, whose rules apply here. Opened because `mem:measurements/test-browsers` is near the 40 000-character limit; it keeps LIB-WIN-MAC, the earlier Windows/macOS entry.

## MACOS-26-27 — the first runs of `tests-macos-26.yaml` and `tests-macos-27.yaml`, 2026-10-21, Chrome 153 / Firefox 155.0.1

**Method.** `tests.yaml` (`pnpm build`, `pnpm test`, `pnpm test:conformance`), dispatched by hand. `macos-26`: macOS 26, arm64. `xcode-27`: macOS 27.0.1 (Darwin 27.0.0, image 20261012.0260.1, public preview; GitHub has no `macos-27` label yet).

| run | runner | ref | result |
|---|---|---|---|
| 39606959948 | `macos-26` | `main` `7108558` | green, 20 min |
| 39606963943 | `xcode-27` | `main` `7108558` | red, 15 min: 1 failed of 3253 (`tx-quiesce` abort test, Firefox `IDBBatchAtomicVFS/jspi`) |
| 39620037006 | `xcode-27` | `main` `7108558` | red, 13 min: the same test, and `lifecycle` "restarts the slot once and keeps serving" on Firefox `OPFSAdaptiveVFS/jspi` (`WORKER_CRASHED: unable to open database file: NoModificationAllowedError`, `mem:follow-ups/lifecycle-restart-held`) |
| 39628784177 | `xcode-27` | `fix/tx-quiesce-abort` `a626998` | **green**, 18 min |

The `xcode-27` machine runs the same read about twice as fast as `macos-26` (TXQ-ABORT-TIMER's `fullRead`).

## TXQ-ABORT-TIMER — `tx-quiesce`'s abort test raced a `sleep(0)` against its read, 2026-10-21, `macos-26` / `xcode-27`, Firefox 155.0.1 and Chrome 153

The test ("follows a tx.read() aborted by its own signal") started a 2000-row `tx.read()` at `chunkSize: 1`, awaited `sleep(0)`, then aborted, and asserted the read rejected. **Method:** throwaway branch `spike/macos27-quiesce`, a workflow looping the test on both runners, a probe in the test logging how long `sleep(0)` took, when the read settled, and how long the same read takes unaborted (`fullRead`).

| loop (runs 39610330477, 39613626108, 39622705953, 39626024104) | `sleep(0)` | failures |
|---|---|---|
| the test alone, 40 × 2 browsers × 2 runners | 0-1 ms (Chrome 0-0.2, one 4.3) | 0 of 160 |
| alone, one busy loop per core, same counts | 0-1 ms | 0 of 160; `fullRead` Firefox 53-245 ms (27) / 102-318 (26), Chrome 40-141 / 60-286 |
| the failing shard (12 files of Firefox `IDBBatchAtomicVFS/jspi`, one Vitest process), 15 × 2 runners | **26-105 ms late in 3/15 (26) and 6/15 (27)** | **1 of 15 on `macos-26`** (`sleep(0)` 64 ms, read settled at 45 ms, before the abort); 0 of 15 on 27 |
| the shard with the fix, 15 × 2 runners | — | 0 of 30 |

**Cause:** after the shard's other files, Firefox runs a `sleep(0)` tens of milliseconds late (the page busy: `fullRead` 120-155 ms in those runs, ~40 otherwise); when the delay outlasts the read, the read finishes before the abort. Not macOS 27's: reproduced on 26; 27's faster read loses the race more often. Why Firefox's page is busy after those files was not looked for. **Fix** (`fix/tx-quiesce-abort`): abort from the read's first `chunk` message (a listener on the intercepted worker, added after the client's own). Falsified: without the statement's `await worker.quiesce()` (`src/transaction.ts`) the test fails with `WORKER_BUSY` on Chrome and Firefox.

## LIFECYCLE-HELD-PROBE — does a restarted worker meet its predecessor's held file, 2026-10-21, `macos-26` / `xcode-27`, Firefox 155.0.1

The failure under study: `lifecycle`'s restart on Firefox `OPFSAdaptiveVFS/jspi`, seen once (run 39620037006, `mem:follow-ups/lifecycle-restart-held`). **Method:** throwaway `spike/lifecycle-restart`. (1) A loop: the test alone 40× and the 27 files that preceded it in that cell 10×, per runner (run 39635092391), and the test alone 30× locally (Linux container, Firefox). (2) A probe in `openWithRetry`: every VFS retries a held file, every held open is reported through a `probe` message with its VFS, attempts and wait; `silent: false`; three full `pnpm test` (run 39640817968, two on `xcode-27`, one on `macos-26`).

| | result |
|---|---|
| loop, `macos-26` / `xcode-27` / local | 50/50, 50/50, 30/30 green |
| probed full suites | 3/3 green; **no restart met a held file**; the only held opens were `pool-cap` "fails to open at all" on `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS` (a live holder: held 1-3 ms in, gave up after 2518-2653 ms, 14-16 attempts) |

So the window is rare and narrow; the fix (`fix/restart-held-file`) was made deterministic by a test that holds the file itself, not by reproducing the engine's window.

## SAFARI27-TIMER-1HZ — Safari 27 runs a test page's timers once a second, its main thread idle, 2026-10-28, `xcode-27`, Safari 27.0.1

**Method.** Throwaway branch `spike/safari27-running-wait` (deleted with its runs, 2026-10-28): the two failing cells (`OPFSWriteAheadVFS/sync`, `OPFSAdaptiveVFS/jspi`) whole through `scripts/test-plan.ts --browser safari --modes not-isolated --full`, `BSQ_TIME_SCALE=2`. `waitUntil` timed each `await sleep(0)` and ran a probe worker posting `Date.now()` every 100 ms (built with the helper's `NativeWorker`, so `interceptWorkers()` does not record it); a timed-out `theQueryIsRunning` printed the history of `db.debug`.

**Result (run 40732354209; 40727661900 alike without the probe).** In every timed-out wait, `setTimeout(0)` fired ~1000 ms after it was set (`+1:837 +838:1002 +1841:997 …`; 21 sleeps in 10 s, the first 438-837 ms), while the worker's messages were handled 1-25 ms after they were posted, and `db.debug`'s end times (main-thread `Date.now()` at the worker's message) fell between two polls. `document.visibilityState = visible`, `document.hasFocus() = false`. Timers held back, the main thread free. It lands on some cells' pages and not others (WriteAhead in one run, Adaptive in the next); alone, in a one-file spike, the same tests were seen running in 11-14 ms (run 40725890211). Safari 26.6.2 does not do it (TIMER-PROBE, `mem:follow-ups/macos-ci-instability`: Safari's page `setTimeout(0)` p50 8 ms). Consequence: `mem:follow-ups/safari27-running-wait`.

## CHECK-PROGRESS — live progress through check runs, 2026-11-03, `ubuntu-latest` / `windows-latest`

**Spike** (`spike/check-progress`, runs 41605727971 and 41605727832, deleted with the branch): a check run created by a job's `GITHUB_TOKEN` (`checks: write`), PATCHed every 10 s, was read back every 15 s through `commits/{sha}/check-runs` with no visible lag; `::notice::` annotations read 0 through the API for the whole job, including two minutes after their step ended, and 11 of 12 appeared at job end; an `if: always()` step ran after a job timeout and after a run cancel, `job.status` `cancelled` in both, and closed the check run; the job's own check reads `cancelled` after a timeout, never `timed_out`. **Every created check run landed in the OTHER workflow's check suite** (the user saw A's annotations on B's run page). No API deletes a check run.

**A foreign failing check run does not turn a green run red** (`spike/progress-failure`, deleted): a `failure` check run created by one workflow landed in a green workflow's suite; that run stayed `success`, and so did its check suite.

**Proving runs of `feat/ci-live-progress`:** `tests-ubuntu.yaml` 41614933716 green, both planners' `Live progress:` links in the job log, `ci-watch.ts` printed 27 lines and exited 0; `matrix.yaml` 41614937442 green, 22 progress check runs `success`, 52 `[n/N]` lines (the 52 cells); `tests-windows.yaml` 41614940797 red on three of our own unit tests, reported live (`path.relative` wrote `\` on Windows; fixed before the merge). **A failure seen live** (a throwaway failing browser test, run 41616175643, deleted): its `FAILED` lines reached `ci-watch.ts` before the `[n/N]` lines of their 193-239 s cells; the check run ended `failure`. **A re-run** (41614933716 attempt 2): `filter=latest` shows only attempt 2's check runs, `filter=all` both — the name without attempt works as meant. **A cancel on Windows** (run 41618274365, cancelled during `Test`): the check run, at 1/19, closed `cancelled` by the closing step — which also proves the `import.meta.url` guard and `$RUNNER_TEMP` under Git Bash there.

**One check run left open (2026-11-03, MATRIX-OS run 41629313260, `macos-26 / cells (OPFSWriteAheadVFS/async)`):** every Checks API call of that job failed at the network level (`ci-progress: publishing stopped: fetch failed` at 12:36, `could not close 125921217428: fetch failed` from the closing step at 12:52), so its progress check run stays `in_progress` ("0/3") on that commit; the job itself green. One of ~110 jobs. The closing step makes one attempt; retrying it a few times is a small fix, proposed and not decided.

## MATRIX-OS — the first matrices on Windows and macOS, 2026-11-03, `ci/matrix-os`

**Method.** `matrix.yaml` as a module (`mem:stack-and-build/ci`), its callers run through a temporary `push` trigger on the branch (`gh workflow run` cannot reach a workflow that exists only on a branch), followed with one `ci-watch.ts --sha … --interval 60`. Chrome 153, Firefox 155.0.1; Safari 26 (`macos-26`), Safari 27.0.1 (`xcode-27`).

| run | what | result |
|---|---|---|
| 41629313193 | CI with its new `matrix` job (Linux) | green; matrix 22/22 + plan |
| 41629313286 | Matrix (Windows), `time-scale '4'` | **green 22/22**, done before the macOS runs; slowest Firefox cell 1444 s (`OPFSCoopSyncVFS/sync`) |
| 41629313297 | Matrix (macOS 27), Safari included | **green 22/22**, ~2 h (macOS jobs shared 5 slots with macOS 26) |
| 41629313260 | Matrix (macOS 26), Safari included | red 20/22 (two Chrome tests, fixed in `test/macos26-flakes`) |
| 41654580706 | Matrix (macOS 26) again, alone, with the fixes | red 20/22 (two other waits bounded at 10 s, a worker over 10 s to start) — `mem:follow-ups/macos-ci-instability` |
| 41714043416 | Matrix (macOS 26), alone, with the startup waits fixed (`test/macos26-startup`), branch `docs/startup-probe-mac`, 1 h 15 | red 20/22, both Chrome, both new: `MemoryVFS/async` — `need-guard.ts`'s OPFS handle probe (a plain blob worker, no wasm) silent 3 × 10 s (`PROBE_BOUND_MS`, unscaled), so `abandon.test.ts` never loads; `OPFSAdaptiveVFS/async` — `abandon-transaction` "leaves a correct transaction untouched" (2 workers, 2 000 rows read in a transaction) over its 60 s. Every test fixed on the earlier runs green; Chrome cells 265-1436 s against Firefox 195-767 s and Safari 38-1006 s — `mem:follow-ups/macos-worker-startup` |
| 41824646551 | Matrix (macOS 26) on `test/retry-timeouts-on-slow-runners` (probe fix and timeout retry), 2026-11-04 | **green 22/22, the first on this runner**; one retry used and passed: `chrome · OPFSAnyContextVFS/async` `abandon-transaction` "commits, and evicts no worker" (its own `{ timeout: 30_000 }`, not scaled) |
| 41824650700 | Matrix (macOS 27), same branch | red 21/22: `chrome · AccessHandlePoolVFS/sync` `tx-savepoint` T5 `expected false to be true` — an assertion, not retried: T5's 30 ms deadline can expire during the verdict round trip, as T4's did (T2 the same; T6 passes vacuously then); reproduced locally with the verdict delayed 60 ms: T2 and T5 red, T6 green |
| 41824642520 | Matrix (Windows), same branch | green 22/22, no retry |
| 41847018002 | Matrix (Windows) on the branch after T2/T5/T6 (`e039c6c2`), 2026-11-04 | red 21/22: `firefox · OPFSWriteAheadVFS/jspi` `tx-timeout` "lets the callback catch the timeout and continue to COMMIT" `expected undefined to be 'OPERATION_TIMEOUT'` — unexplained: not the verdict race (a verdict delayed 300 ms still gives `OPERATION_TIMEOUT` locally), so all() resolved before its 200 ms were seen (2M rows take ~500 ms locally) or threw without a `code`; the test now says which in its failure message |
| 41847029385 | Matrix (macOS 27), same commit | red 21/22: T5 green; `chrome · OPFSAnyContextVFS/async` `abandon` "at the deadline, when the caller set a timeout" `expected false to be true` — the pool served after the reclaim, but past `servesWithin(db, 8000)`, a fixed 8 s; now `serves(db)` waits for the read under the test's own timeout (A/B with the deadline at 9 s: old red with this message, new green) |
| 41847023450 | Matrix (macOS 26), same commit | 14/14 that ran green; 8 cells never got a runner, cancelled by GitHub after ~2 h (`The job was not acquired by Runner of type hosted even after multiple attempts`; notice: capacity constraints on macOS arm64) |

**Throughput.** Two macOS matrices together queue 46 jobs on 5 macOS slots (free plan, as observed: 5 running at once). `ci-watch.ts` printed the runs' conclusions only at the end of all of them until `0e5d768f` (now: each as it completes).

## CHROME-STALL-SPIKE — Chrome workers on the macOS 26 runner, idle and under a pair's load, 2026-11-04, branch `spike/macos26-chrome-stall`

**Method.** Run 41802800134, one `macos-26` job (3 cores, HeadlessChrome 153): a page (`spike/chrome-stall/index.html`) in its own headless Chrome driven over CDP, alternating two rounds bounded at 60 s each: A, a plain blob worker (no wasm, no library), page-side time to its first message then to each of `getDirectory`, `getFileHandle`, `createSyncAccessHandle`, close + `removeEntry`, one message per stage; B, a `poolSize: 2` `OPFSAdaptiveVFS/async` client (each worker's boot stages, `ready`, CREATE, 2 000-row seed, a chunked read in a transaction — `abandon-transaction`'s failed test). 3 min idle, then beside `test-matrix.ts --pair OPFSAdaptiveVFS/async` on Chrome and Firefox, both modes, `BSQ_TIME_SCALE=2` (17 min, green), then 1 min; `uptime` every 15 s.

| | idle (106 + 106) | under the pair (428 + 428) | after (38 + 38) |
|---|---|---|---|
| load average, 1 min | 22 (max 34) | 63 (p90 104, max 115) | 10 |
| A spawn → first message, p50 / p99 / max ms | 10 / 47 / 138 | 25 / 333 / 555 | 9 / 23 / 23 |
| A each OPFS call, max ms | 107 | 56 | 126 |
| B create → `ready`, p50 / max | 124 / 524 | 199 / 1 061 | 118 / 253 |
| B whole round, p50 / max | 339 / 952 | 609 / 1 741 | 330 / 529 |

No error, no round over 1 s (A) or 3 s (B), in 1 144 rounds. **Reading.** A pair's load slows Chrome's worker work 2-5× at the median and up to ~10× at the tail on this runner, not the 10-60 s of the matrix's two failures (run 41714043416). Those are rare: about one per pair job, in 2 of 22 jobs, against none in this job's 856 loaded rounds. The `need-guard.ts` probe that failed there (3 × 10 s silent) runs no library code, so a worker silent over 10 s is the runner's (or Chrome's on it), not the library's; which stage stalls is still unseen.
