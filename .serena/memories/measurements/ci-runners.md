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
