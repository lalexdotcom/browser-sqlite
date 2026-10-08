# Measurements — the test suite, the matrix, the Firefox harness

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## INSECURE-CONTEXT — the library on a page that is not a secure context, 2026-10-03, Playwright 1.62.1 Chromium + Firefox, this container

**Method.** The built `dist/` and a page creating a client per VFS (`write` then `read`), plus `deleteDatabase` and `inspectDatabase`, served by one Node server on `0.0.0.0` and loaded twice: `http://127.0.0.1` (secure, control) and `http://192.168.215.5`, the container's own address (insecure: `isSecureContext` false, no `navigator.storage`, no `navigator.locks`, no `FileSystemSyncAccessHandle` in workers).
- **Before:** every client failed at construction, `TypeError: crypto.randomUUID is not a function` (secure-context-only; `client.ts`, `inspect.ts`, `bulk.ts`).
- **`randomUUID` replaced by `randomId()` (`getRandomValues`):** every client failed `WORKER_CRASHED`, wa-sqlite's `OPFSAdaptiveVFS.js` line 9 at worker load, both engines.
- **That line guarded (`?.`, in `patches/`):** `MemoryVFS` and `MemoryAsyncVFS` ok; `IDBBatchAtomicVFS` opened then `disk I/O error` (`WebLocksMixin`: `navigator.locks` undefined); `IDBMirrorVFS` `unable to open database file`; OPFS VFS refused on `opfs`.
- **`web-locks` required by every non-memory VFS:** memory VFS ok; IndexedDB and OPFS VFS refused at construction, `INVALID_OPTION` naming the API, the insecure context and only `MemoryVFS, MemoryAsyncVFS` as alternatives. `deleteDatabase`: memory ok; OPFS failed `WORKER_CRASHED` (`navigator.storage` undefined) until it got the same check, now `INVALID_OPTION`; IndexedDB the same. `inspectDatabase`: already clean (`UNSUPPORTED` without Web Locks, `INVALID_OPTION` on a memory VFS).
- **Secure control:** every VFS ok throughout; `deleteDatabase` of a missing database `DATABASE_NOT_FOUND`.

No automated test covers an insecure context (rstest serves `localhost`); the unit tests cover the requirement, the message and `randomId`.

## RSTEST-OTR — rstest's OPFS is off-the-record and ~250× dearer per call, 2026-09-28, Chromium, this container

A pure OPFS micro-bench — 7 772 frames of 24 + 4096 bytes written, then read back as two `read()` calls per frame, then 2 000 `write()` calls — with no library and no wa-sqlite. Same source in every harness, three rounds, default and `readwrite-unsafe` handles, with and without a second handle open — none of those three variables moved it.

| harness | `read()` per call | `write()` per call |
| --- | ---: | ---: |
| rstest browser mode | 152-166 µs | 268-280 µs |
| web-test-runner (chrome-launcher, persistent profile) | 0.57-0.66 µs | 2.05-2.45 µs |
| Playwright `launchPersistentContext`, same binary | 0.55-0.62 µs | 2.35-3.05 µs |
| Playwright `browser.newContext()`, same binary | 159-173 µs | 287-295 µs |

rstest's browser provider calls `newContext()`, an off-the-record context. Why that context is slow per call is not verified — Chromium keeping an off-the-record OPFS in memory in the browser process, one IPC per call, is the likely reading. Found because the pragma arm of 365-LIB cost 45× what wa-sqlite's runner measured: instrumented, the same 31.8 MB were scanned, the checksum took 40 ms and the `read()` calls 2.6 s; build (`sync`, `jspi`), headless shell and transpilation were each ruled out by a run of their own.

## REUSE-LOAD — the whole Firefox config under load, 2026-09-27, this container

The arm LEASE-QUIESCE left open: not one file under load but the whole Firefox config, the context of the single 2026-09-14 sighting. `rstest --config rstest.firefox.config.ts` (both Firefox target projects, every browser file) ten times in a row under sixteen busy loops (16 cores), `main` on pin `5e98ac7` with #363. Detection: `WORKER_BUSY` or "already has a query in flight" anywhere in each report, which is where a query rejected by the guard lands.

- **0 hits in 10 passes**, 7 453 tests passed, no page crash. ~200 s per pass.
- **7 failures, two tests, both a 30 s timeout, neither the guard:** `interrupt.test.ts :: leaves a sync build degraded` in **6 of 10** passes (both projects — it pins `OPFSWriteAheadVFS/sync`, so the pair is the same), "completed 1 expect assertion"; and `open-retry :: succeeds once the holder lets go` once (`mem:follow-ups`).
- **The `interrupt` one is the test's budget, not a defect:** alone on the idle machine it passes 3/3, and its file's test phase takes **22.6-23.0 s** — the 20 M-row query the `sync` build cannot cut runs to its end inside `close()`, against the 30 s default. 1.3× of margin, which the load eats. **Fixed the same day** by giving that client `drainTimeout: 2_000`, and renamed `rejects an aborted read at once on a sync build without isolation`: 3/3 idle per engine (Firefox 0.8-2.9 s, Chromium ~0.2 s), **20/20 under sixteen busy loops**, slowest 3.9 s — inside the 2 × 2 s the two bounded waits of `close()` allow.

## CI-QUERY-TIMEOUT — a statement the `sync` build cannot cut, and how long its neighbours wait, 2026-09-15, both engines

**Method.** Two throwaway probes, copied into `tests/browser/` for a run and deleted. `MemoryVFS`,
`poolSize` 1, no cross-origin isolation, `main` at `87076f6`. "Loaded" is 32 busy loops on this
16-core container. Asked by the first CI run of rc.5 that reached its tests (run 34950424311), where
two `query-timeout.test.ts` tests timed out at 30 s after their assertions had passed.

| `longQuery(20M)`, warm client | Chromium `sync` | Chromium `async` | Firefox `sync` | Firefox `async` |
|---|---|---|---|---|
| runs to its end, idle | 4.4 s | 5.5 s | 22.9 s | 31.6 s |
| runs to its end, loaded | 12.8 s | 13.6 s | 67.7 s | 99.1 s |
| next read after a `timeout: 200` rejection, idle | 2.6 s | 0.21 s | 22.8 s | 0.20 s |
| same, loaded | 7.5 s | 0.21 s | 60.5 s | 0.23 s |

**On a FRESH client, the test's own shape** (`timeout: 200`, then a read; n=3): idle, the worker
starts in 43-73 ms and the long statement always runs — the read waits 4.2 s (Chromium) or 22.2 s
(Firefox). Loaded on Firefox: **60.1 s, 71 ms, 60.2 s** — bimodal, because a startup past the
budget rejects the call while it is still queued and nothing runs. A single loaded run of the file
passed for exactly that reason.

**`async` alone was not enough (until 2026-10-02).** A statement yielded only when it was abortable
(`wantsSignal`) or its VFS declared `yieldsDuringStatements`, so an unsignalled long read on
`MemoryVFS` held its worker on `async` too, and `close()` waited it out: the queued test still failed
on Firefox until its holder carried a signal. Every statement yields since `feat/always-abortable`
(GEN-ABORT).

**What it settled.** The tests pinned no interruption: the rejection is immediate by contract,
and the statement ran on regardless. They now run on `async`, warmed, every statement they expect
to cut carrying a signal or a timeout, the next read bounded at 2 s. **Verified the same day:** the
file 8/8 on Chromium (4 s) and on Firefox (5 s), and 8/8 three times on Firefox under 32 loops
(9-10 s); its falsifier, the first test back on `sync`, fails on Chromium with `expected 4164.5 to
be less than 2000`. `sync` without isolation keeps its documented limitation;
`interrupt.test.ts` pins it on purpose. **Firefox runs this recursive CTE four to five times
slower than Chromium** — a bound calibrated on Chromium is a bound Firefox may not meet.

\1

## MATRIX-TRIAGE — from 989 cell-failures to 62, 2026-09-15 to 18, this container

Merged on 2026-10-08 from MATRIX-1, -2, -3 and -5; their own wording is in git. **No longer the reference**: the matrix reads 66 of 66 since 2026-09-21, and a regression is read against `mem:state`'s baseline.

**Method.** `pnpm test:matrix`: 22 declared pairs × {chromium, firefox, isolated} = 66 cells, one rstest project per pair, each bounded at 600 s. Triaged with `scripts/matrix-triage.mjs`. rstest truncates long failure lists (690 of 989 listed at MATRIX-2), so group counts under-report the widest causes.

| | M-1 (09-15) | M-2 (09-16) | M-3 (+cleanup, 09-16) | +needs | **M-5 (09-18)** |
| --- | ---: | ---: | ---: | ---: | ---: |
| wall clock | 3447 s | 2386 s | 2885 s | | 3067 s |
| cell-failures | | 989 | 500 | 79 | **62** |
| distinct groups | | 143 | 97 | 26 | **20** |
| green cells /66 | | 36 | 36 | 49 | **52** |

M-1 → M-2 is the per-cell redundancy removed when the five VFS-sweeping files started following the target. Firefox `IDBMirrorVFS/async` timed out in M-1 (the Firefox hang) and reported its 334 tests from M-2 on (the probe's bound, `6560c9e`). `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS`, `OPFSAnyContextVFS` and the whole `isolated` column were green throughout.

**Per VFS, summed over its six browser cells:** `AccessHandlePoolVFS` 593 → 102 → 18 → **0** · `MemoryVFS` 126 → **0** · `MemoryAsyncVFS` 84 → **0** · `IDBMirrorVFS` 98 → **46** · `IDBBatchAtomicVFS` 16 → **8** · `OPFSCoopSyncVFS` 72 → 74 → 7 → **8**.

**The piles at M-2**, re-cut at M-3 rather than carried forward: tests assuming what they do not declare ~412 (`poolSize: 2` pinned on a capped VFS 250, inspection on a memory VFS 120, `statement-errors` writing a raw OPFS file 36, `default-pragmas` vs AccessHandlePool's `locking_mode` 6) — 420 at M-3, it GREW as AccessHandlePool tests reached their real cause; ~258 called "our own test infrastructure", all on `AccessHandlePoolVFS` — the previous test's client never closed, so its pool slot never returned — which was the symptom counted correctly under a cause that was wrong; and ~60 probable product defects (`IDBMirrorVFS` `database disk image is malformed`, `IDBBatchAtomicVFS` an abandoned write through a generator inside a transaction, `OPFSCoopSyncVFS` `DATABASE_NOT_FOUND` for a database the test created), 62 at M-3. M-3 also made 18 `createSyncAccessHandle` collisions visible in `lifecycle.test.ts` and `long-query.test.ts` (`mem:follow-ups`). The three product piles went to zero on 2026-09-18: VFS-PILES, `mem:measurements/wa-sqlite-prs`.

**The cleanup fix (`bbd0862`: `onTestFinished` + `close()` + `deleteDatabase` on the `opfs-pool` layout), each piece measured necessary** on `queries.test.ts` against `AccessHandlePoolVFS/sync`: 5/11 before · 5/11 with `onTestFinished` but no `deleteDatabase` · **11/11 with both**. `close()` alone cannot help — wa-sqlite's `jClose` flushes and drops the `fileId`, only `xDelete` frees a slot, and `DEFAULT_CAPACITY` is 6. At M-5 all nine `AccessHandlePoolVFS` cells were green, where only `chromium/sync` had been verified by hand, and the cleanup that no longer swallows created no failure on any cell.

**A whole-matrix run is not the instrument for a pile.** Two of them (80 min) said only "99, unchanged"; one instrumented single-file run answered it. Reach for `BSQ_TEST_TARGETS=<pair> pnpm exec rstest --config <cfg> --project 'chromium*' run <one file>` first — ~25 s.

**M-5's one regression, `OPFSCoopSyncVFS` 7 → 8.** Both `sqlite3_open_v2` failures (`restarts the slot once`, `a worker killed silently`) were read as HANDLE-CORPSE on a path the fix does not cover — `AccessHandlePoolVFS` takes its directory at VFS **creation**, where `createVfsInstance` retries, while an `opfs-path` VFS takes the file's handle later at **xOpen**, inside `sqlite3_open_v2`. Fixed the same day, and the hypothesis was only half of it: the corpse starts it, but what made it permanent is the partial-acquisition leak (wa-sqlite #350, VFS-PILES), which is why a retry at `xOpen` was necessary and not sufficient. Closed by measurement on 2026-09-21: COOPSYNC-OPEN-CLOSED, `mem:measurements/opfs-handles`.

## MATRIX-DEFAULT-BUILD — the matrix after `jspi` moved before `async`, 2026-09-24

The run of 2026-09-24, `feat/default-build`, 2570 s, 66 of 66 cells green, 0 failing tests. Passed / failed / skipped per cell, identical across the builds of one VFS:

| VFS | chromium | firefox | isolated |
|---|---|---|---|
| `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `OPFSAnyContextVFS` | 366/0/4 | 370/0/1 | 7/0/0 |
| `IDBBatchAtomicVFS`, `IDBMirrorVFS` | 365/0/5 | 369/0/2 | 7/0/0 |
| `MemoryVFS`, `MemoryAsyncVFS` | 361/0/9 | 365/0/6 | 7/0/0 |

Cells ran 22-79 s. In every row, on both engines, the `async` cell is the slowest of its VFS — by 4-7 s on Chromium and 3-10 s on Firefox against the next one. Wall clock per cell, setup included: a hint that agrees with the bench, not a benchmark.

## GETDIR-HANG closed — the Firefox `getDirectory()` hang was `firefox-1538`'s, 2026-10-08

The rstest/Firefox silent hang (`navigator.storage.getDirectory()` never settling in a worker, which wedged a whole run through the conformance probe's top-level await) measured 4 hangs in 24 runs on 2026-09-16 with the probe unguarded. Re-measured after the Playwright 1.64.0 bump, same arm: the probe's bound lifted to one attempt of 600 s (local edit, reverted), `firefox · OPFSWriteAheadVFS/sync` alone, 24 runs under a 240 s deadline each — **24 passed, 0 hangs, 41-43 s each**, on `firefox-1555` (Firefox 157). Closed as the build's, as the entry planned; the probe's bound and `bounded.ts` stay. The library's own exposure (workers calling `getDirectory()` in every OPFS VFS's `create()`, nothing bounding a worker's startup) was never seen outside that build.

## LIFECYCLE-SEGV — the Firefox page crash on `lifecycle.test.ts`, 2026-10-02/03, this container

Playwright 1.62.1, `firefox-1538`, target `OPFSAdaptiveVFS/jspi` (the two-worker tests fall back to `OPFSAnyContextVFS`). "Amplified" = the file's top-level describes wrapped in a 40-round loop in one page, `bounds` skipped, alone in its config.

| Run | SIGSEGV |
|---|---|
| Whole Firefox config + eight `open-retry` copies (the 2026-09-28 condition), as is / without the two silent-worker tests | 0/20 / 0/20 |
| Amplified, whole file | 10/10, 4-73 s in |
| Amplified, without the two tests using `silentWorkersFromIndex` | 0/10 |
| Amplified, one of the two only / both without the slot-0-kill test | 2/5, 3/5 / 4/5 |
| Amplified, helper on the real `worker.js` made deaf (`postMessage` dropped) | 10/10 |
| The gate sequence alone ×100 (own client, no `createTestClient`): full / no cleanup / no slot-0 kill | 4/4 / 4/4 / 4/4 |
| … without killing the retry's replacement / round-1 kill only / round-1 kill then 200 ms | 0/4 / 0/4 / 0/4 |
| … the same kills on REAL workers (no silent one) | 4/4 |
| … HMR and live reload off (`dev.hmr: false`, `liveReload: false`) | 7/8 |
| `spawnWorker` alone ×150, `terminate()` at once / 0-6 ms / 20-60 ms after | 0/3 / 3/3 / 0/3 |
| **Amplified, with the fix (kill a silent worker only after its boot signal)** | **0/10**, 640 passed each |

The killed replacement is spawned by the retry and killed within the test's 10 ms poll — inside the window. `pnpm test` with the fix: 1350 / 792 / 18 passed, 0 failed. **Outside rstest (2026-10-03).** A plain page creating classic workers two at a time — `new Worker(url)` ×2, `await sleep(i % 7)`, `terminate()`, `await sleep(i % 3)`, `terminate()`, 150 iterations: Playwright's Firefox 20/20 (`blob:` or static script, with or without `postMessage`, also the `firefox-1538` binary launched alone without Playwright, 6/6); the same loop with module workers (`blob:`, static, or the real `dist/worker/worker.js`, with or without a message) 0/58; any worker held 50-500 ms before `terminate()` 0/18. Stock Firefox 153.0 (build 20260715202819, linux-aarch64, headless, crash reporter on; a manual `kill -SEGV` of a content process is seen as a dead process and a minidump), the same page at 600 iterations: 0/20 classic, `blob:` or static. Detection there: a 200 ms heartbeat to the page's server and the content processes' PIDs, not the crash reporter (which wrote nothing for `about:crashcontent` from the command line).

**The other test files, 2026-10-03.** A setup file loaded into every page recorded each `terminate()`: the worker's age and whether it had posted anything. Age alone does not mark the window — the fixed silent workers are killed 5-11 ms old, after their boot signal, and never crash — so "young (< 30 ms) and silent" only names suspects. Whole Firefox config: 1750 terminations, 34 suspects in 13 tests; every Firefox target (`BSQ_TEST_TARGETS=all`): 16346 terminations, 7893 passed, 0 crashes, the suspects in the same four files — `lifecycle`, `failed-client` (1 test), `inspect-marker` (2), `second-client` (2, killed 0-5 ms old); Firefox conformance: 180 terminations, no suspect. The three other files amplified ×40: 0 crashes in 5 passes each on the default targets and in 1 pass each on every Firefox target (1800 / 4497 / 3520 passed; `inspect-marker`'s failures are all its `ledger N` label, a per-page counter the loop advances).

## WORKER-LEAK — Firefox `DOM Worker` threads that outlive `terminate()`, 2026-09-29 to 2026-10-03, this container

Playwright's Firefox (`firefox-1538`); threads counted from `/proc/<pid>/task/*/comm == "DOM Worker"` of every Firefox process.

**2026-09-29**, a standalone page (no rstest) replaying the scenarios in same-origin iframes recreated every round — `open-retry`'s holder on `OPFSCoopSyncVFS`, and the slot-0 kill on `OPFSAnyContextVFS` with a missing-URL or a silent blob worker: no crash in ~480 rounds, but a **freeze** at 513 live `DOM Worker` threads in the content process — Firefox's 512-workers-per-domain cap, after which no new worker starts. Per 20 rounds × 2 lifecycle frames: missing-URL variant 0 threads left, silent-blob variant 11-19 (revoking the blob URL or not changes nothing), `open-retry`'s holder 0. The library calls the native `terminate()` on every worker it declares dead (`handleDeath` → pool `terminate` → `nativeTerminate`), and the threads outlive their iframe's destruction. Without the library, terminating a just-created blob worker: 3 left in 200 at 0 ms, 0 at ≥10 ms.

**2026-10-02**, iframe per round, 2 workers per round, 40 rounds, counted 3 s and 10 s after (identical both times). Without the library: silent blob + dispatched `error` + `terminate()` at 0 ms — 0/80 then 1/80 on a second run; at 10 ms 0/80; a worker writing OPFS through `createWritable`, `terminate()`d once open, 0/80; a worker holding a compiled `wa-sqlite-jspi.wasm`, 0/80; a silent blob **never terminated**, its iframe removed, 45/80 then 33/80 alive at 10 s. Through `dist/index.js` (`OPFSAnyContextVFS`, pool of 2): open-write-close 0, the same without `close()` 0, the missing-URL slot-0-kill sequence 0, the silent-blob gate sequence **4** (40 rounds, 80 silent + 40 real workers). The leaked threads are in the page's own content process.

**2026-10-03, stock against Playwright, same harness.** Each binary launched alone (no Playwright driving), headless; a page runs the iframe rounds unattended and reports, per frame, the workers created and the distinct workers given a native `terminate()` (`Worker.prototype.terminate` wrapped); threads counted before the rounds and 10 s after.

| Variant | created / terminated | Stock Firefox 153.0 | `firefox-1538` |
|---|---|---|---|
| control, 0 rounds | 0 / 0 | +1 (an internal worker Firefox starts on its own) | 0 |
| never terminated, iframe removed | 80 / 0 | +1 | **43** |
| silent classic blob, `terminate()` at 0 / 50 ms | 400 / 400 each | +1 / +1 | 0 / 0 |
| silent module blob, `terminate()` at 0 / 50 ms | 400 / 400 each | +1 / +1 | 1 / 0 |
| `dist/index.js`, open-write-close | 120 / 120 | +1 | 0 |
| `dist/index.js`, missing-URL slot-0-kill sequence | 180 / 180 | +1 | 0 |
| `dist/index.js`, silent-blob gate sequence | **300 / 300** | **+1** | **17** |

**Verdict: the leak is the Playwright build's, not the library's.** Every worker the library creates is given its `terminate()`, and the threads that survive it do so on `firefox-1538` only; stock Firefox reaps them all, even workers never terminated. The library's gate sequence triggers it far more often than a bare blob (17/300 against 0-1/400) — it ends module workers at varied points of their startup — without being its cause. Not established: Playwright's patches or a Firefox change between the two build dates (20260715 stock, 20260722 Playwright's).

**Can the leak reach the 512-worker cap in the suite? (2026-10-03)** `DOM Worker` threads of every `firefox-1538` process sampled every 3 s during a whole Firefox config run: default targets, 104 s, 792 passed, 85 content processes, peak 4 threads in one process; every Firefox target (`BSQ_TEST_TARGETS=all`), 716 s, 7893 passed, 795 content processes, peak 5 in one process, 25 across all processes at once. rstest gives each test page its own content process, so leaked threads never accumulate toward the cap; the 2026-09-29 freeze needed ~480 rounds in one page.

## LIFECYCLE-INIT-RACE — a `BUSY` at cleanup after the restart budget is spent, 2026-10-05, Chromium, this container

The repin to `96d91182` (which changed the `async` build) read 65/66: `chromium · AccessHandlePoolVFS/async` lost `lifecycle.test.ts :: fails the client permanently once the restart budget is spent`, the cleanup's `deleteDatabase` answering `BUSY` — `bsq:init`, the open lock, still held. A/B against `7fcc30df` in a detached worktree, arms alternated:

| | `96d91182` | `7fcc30df` |
|---|---|---|
| that file alone, idle | 20/20 green | 20/20 |
| that file under sixteen busy loops | 50/50 | 50/50 |
| the whole cell (62 files) | 10/10 | 10/10 |
| replacement's `ready` after the first kill, idle (n=60) | 70-89 ms | 71-89 ms |
| same under sixteen busy loops (n=60) | median 191, max 288 ms | median 191, max 260 ms |
| replacement killed on its `opening the database` signal, then `deleteDatabase` at once | `BUSY` 15/15, lock free after 76-91 ms | `BUSY` 15/15, 77-87 ms |

**The mechanism, forced on both pins:** a worker holds `bsq:init` from `opening the database` to `ready` (open and pragmas, ~40 ms of its boot); `terminate()` releases it asynchronously, ~80 ms later. The test killed the replacement 300 + 100 ms after the first kill, assuming it ready, so a replacement late by more than ~300 ms is killed inside the lock and the cleanup lands in those 80 ms. **What delayed it in the matrix is not known** — 288 ms was the worst measured, and the failing report prints no boot trace; nothing ties it to the pin. Fixed in the test: wait for the replacement's `ready` instead of the 300 ms.