# State — where the work stands

**Updated 2026-10-26.** Rewrite this whole file when it stops being true; do not append a
new dated section under the old one, and move what closes to `mem:history` rather than
keeping it here struck through (rewritten on 2026-10-08 from 38 000 characters, two thirds of
them closed subjects).

**No SHAs, no commit counts, no branch names here (user, 2026-08-27).** `git log`,
`git status` and `git branch` answer all of that in one command and always correctly, while
a copy here rots — it did three times in a single day. This file is decisions, obligations and
unmeasured ground.

## Standing facts

- **`1.0.0-rc.10` is published** (2026-10-09): on npm under `rc`, `next` and `latest`, and as a
  GitHub prerelease whose body is the CHANGELOG section for the tag. Over rc.9 (`AVAILABLE_VFS`)
  it ships the introspection pragmas as reads (#5), the breaking multi-statement binding (each
  statement of anonymous `?` takes the next values) and the `WORKER_BUSY`-after-abort fix.
  `package.json` sits at `1.0.0-rc.10` until the user calls the next bump. The release gate —
  28 jobs, `verify`, `consumer-smoke`, 22/22 cells, then `release` — ran green first time in
  ~19 min (one cell, `AccessHandlePoolVFS/sync`, started late); the registry showed the new
  tags about two minutes after the job ended. At rc.8 two cells (`OPFSCoopSyncVFS/async`, `MemoryAsyncVFS/jspi`) took
  ~17 min against 3-9 for the others, under the 25-minute job limit — not looked into, and not
  seen at rc.9.
  Procedure: `mem:conventions/releasing`.
- **The vendored wa-sqlite sits on upstream `master` `66336807`** (2026-10-23 night: our #381, #382, #384, #385 merged; `package.json` has the SHA), and **the patch carries three PRs of ours**: #386 (the `OPFSCoopSyncVFS` startup sweep), #387 (`getIDBFactory`/`prefix`, unused here) and #388 (`step_asap()`, which the worker steps through; the library's own fast step is deleted). Heads and merges in
  `mem:stack-and-build/wa-sqlite`, reports in `mem:upstream`. A patch is added, regenerated or
  removed through `pnpm patch` / `pnpm patch-commit` / `pnpm patch-remove`, never by hand.
- **`main` may sit ahead of `origin/main` indefinitely** — the convention, not an oversight. It
  is pushed for a release, not as housekeeping.

## The verification baseline — compare against these, re-measured 2026-10-13

Not history: the numbers a regression is detected against. **Every figure below was read off ONE sequential pass in this container (Debian 13 aarch64, 16 cores) on 2026-10-13, at `main` `9e9f66b`** (plan C step 5 merged: every browser test tagged, run only on its eligible pairs) — Vitest 5.0.3, Chrome for Testing 153.0.8010.52, Firefox 155.0.1, the wa-sqlite pin `94cd1e7d` (`mem:stack-and-build/wa-sqlite`) with `patches/wa-sqlite@1.1.2.patch`. The figures of 2026-10-10 predate the planner (plans B and C) and are not comparable: a test then ran in every target project, now only on the pairs its tags admit.

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean, 1 s |
| `pnpm build` | clean, 13 s |
| `pnpm test` | ONE merged report, exit 0, **340 files passed, 2956 tests: 2466 passed, 490 skipped, 0 failed**, **127 s** wall (99 s of jobs; 16 cells, 12 at a time). Plan: start pairs `OPFSWriteAheadVFS/sync` and the engine's other recommended pair per browser, complement cells for the rest, isolated cells on the `sync` pairs |
| `pnpm test:unit` | **909** tests, 42 files, 5 s |
| `pnpm test:conformance` | ONE merged report, both engines — 6 files, **162 passed / 32 skipped**, 36 s. Each VFS runs on its default build for the engine |
| `pnpm exec biome ci .` | exit 0 |
| `pnpm lint` | 212 files, **0 warnings** — the file count moves with the tree, **the warning count is the signal** |
| `pnpm docs:vfs` | leaves `VFS.md` and `README.md` unchanged (`git diff --exit-code`) |
| `pnpm test:consumer` | 24/24 stages, 52 s |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chrome --all` | `OK`, `"reasons": {}`, 114 s; the checker requires `poolSize` and `longQueryCalibration` among the keys. `bench:build`, not `build`: the checker serves `_site/`. Pass `BENCH_PORT` to leave 8099 to `bench:serve` |
| `dependencies` in `package.json` | absent |
| `pnpm test:matrix` | **52 of 52 cells green, 842 s** wall (805 s of jobs, 12 cells at a time), dead list empty: `chrome` 22 cells, 7 377 passed / 1 159 skipped, 100-481 s a cell; `firefox` 22 cells, 7 338 / 1 253, 99-266 s; `isolated-chrome` 4 cells (the `sync` pairs), 98 / 198, 28-36 s; `isolated-firefox` 4 cells, 96 / 196, 25-41 s. The slowest cells are `chrome · OPFSAnyContextVFS/*` |

Detail of the matrix, and how earlier ones were reached: `mem:measurements/suite-and-matrix`.

**The table was taken at 12 processes; the default is 6 since the same afternoon (user)** — at 6, same tree: `pnpm test` 143 s, the matrix 949 s (PARALLEL-CAP). The next full pass rewrites the table at 6. **Since `ci/test-triggers` (2026-10-13) `pnpm test:consumer` has 26 stages** (publint and attw added, 26/26 green), and the delivery verification is `node scripts/hook-gate.ts delivery --run` (`mem:conventions`, § What runs where); the table's consumer row predates both.

**Do not reconcile any of these by arithmetic; re-run, and re-measure the whole table when you
touch it — never patch one cell.** Twice in September a total here went stale or contradicted its
own prose because one cell was patched and the table was not re-read. The per-column split is
here on purpose: a total alone cannot say which suite moved.

- **`pnpm test` is ONE run** (several Vitest processes merged into one report, `mem:stack-and-build`, "Parallel runs") bounded at 2400 s, so a green `pnpm test` covers what CI covers; a red Chrome no longer hides Firefox. A job that leaves no blob fails it by name. A commit pays only the unit project; a merge or a push pays the whole run (`mem:git-hooks`).
- **A green `pnpm test` is not a green tree: run `pnpm exec tsc --noEmit` beside it** — a commit
  once landed with a failing typecheck no test run could show (`mem:lessons`).
- **Read the `Test Files` line as well as `Tests`:** a file can fail with no failed test (a setup or an unhandled error, the storage wipe or the isolation check included), which the test counters cannot show.
- **What "skipped" holds since the planner:** Vitest reports as skipped every test of a running file that the plan did not give that cell (its tags exclude the cell's pair, or another cell runs it), so the skipped count moves with the plan and is not the signal. **The signal is the "Skipped with a reason" list printed after the report** — today exactly `abandon-gc.test.ts`'s two tests (no `--expose-gc`; `BSQ_EXPOSE_GC=1` runs them on Chrome), on every non-isolated cell that holds them — **and the plan's "Not applicable" counts: chrome 20, isolated chrome 14, firefox 11, isolated firefox 5** (e.g. the barrier catch-up pragma needs `two-workers` on OPFSWriteAheadVFS, absent on Firefox; the capped-pool tests need `env-capped-pool`, absent on Chrome). Compare those lists before and after a browser pin changes. **Any other reasoned skip, or a not-applicable count that moves without a tag or declaration change, is something to look at.**
- **The engines' conformance counts differ by design**: on Firefox two invariants skip
  `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which run one worker there (`oneWorkerHere` in
  `tests/browser/helpers/environment.ts`). Any other divergence means something skipped that should not.
- **A failure on the Firefox project is signal, not noise** — it is the only one without
  `readwrite-unsafe`, so it is where a reduced-mode regression lands first. A Firefox browser test
  that fails once on CI and passes on a re-run is not automatically noise here: a load-sensitive
  defect once reproduced about once in eighteen runs of `pnpm test` and never in isolation, and
  sixteen busy loops around a single-file Firefox run cut time-to-failure twentyfold (ABANDON-WEDGE,
  `mem:measurements/aborts`).

## In progress

- **The API-consistency group is done (2026-10-26, `fix/tx-api-consistency`, merged and pushed):** `tx.*` rejects instead of throwing, the transaction's read methods refuse writes, a worker's JS exception is `WORKER_ERROR` (`mem:history/2026-10-26-to-11-01`). **`timeout` counts from the call for `stream()`/`chunk()` too** (`fix/timeout-from-call`, merged, breaking). Both were merged without the GitHub matrix (user: "clôture en l'état"); `main` was then pushed (`a17b6c6`): CI, the matrix (23/23), Windows and macOS 27 green; macOS 26 failed twice with no library cause (a lost Safari session, then a 30 s bound crossed), which led to `ci/macos-time-scale` (merged 2026-10-26, pushed 2026-10-28 with `7cb5122`): the macOS workflows run at `BSQ_TIME_SCALE=2`, because Chrome's and Firefox's timers are ~4× slower on GitHub's macOS runners and not on a real Mac (`mem:follow-ups/macos-ci-instability`). **Verified 2026-10-28** with the push of `7cb5122`: macOS 26 green; macOS 27 red, on the routing branch's tests only (below). **Next workstream, the user's pick from the `mem:follow-ups` index** (Claude's recommendation: `named-params` and `bulkwrite-types` first, then the defaults: `jspi-before-sync`, `temp-store-anycontext`, `firefox-opfs-fsync`). **Done 2026-10-28: the large, breaking `mem:follow-ups/sqlite-routing`** (`run()`, routing by SQLite's verdict, streamed writes) is merged into `main` and **pushed (`7cb5122`, user)**: delivery gate and GitHub matrix green on the branch, steady state equal to the previous `main` (`mem:measurements/routing`), `mem:history/2026-10-26-to-11-01`. On that push: CI, the matrix (23/23), Windows and **macOS 26 green — the first macOS 26 green at `BSQ_TIME_SCALE=2`**; **macOS 27 red twice** on the routing branch's tests waiting for a long statement to run, Safari 27 only (`mem:follow-ups/safari27-running-wait`) — fixed 2026-10-28 (`fix/safari27-wait-yield`): Safari 27 held the test page's timers to 1 Hz, `waitUntil` now polls on a message; macOS 27 green twice (562/562, conformance 9/9). **Next workstream, the user's pick**; as recommended before: additive features (params by name, `bulkWrite` types), defaults (`jspi` first, `temp_store` on AnyContext, Firefox OPFS fsyncs and the 30 s open timeout) — all in the `mem:follow-ups` index. Also open: the WebDriver PR for wa-sqlite (Discussion #373); waiting on others: wa-sqlite #386/#387/#388 (#388's revision committed locally, `mem:follow-ups/wa-step-upstream`), #297 `trace_v2`. **Dependabot PR #8** (docker-in-docker 4.1.2 → 4.1.3, opened 2026-10-14) is open and untouched — the user's call.
- **Before that: nothing was in progress (2026-10-24, night).** `main` is pushed up to `41c4dfd` (the repin to `66336807` with #388 carried); on that push CI, the matrix (23/23), macOS 26 and macOS 27 were green, **Windows failed one test**: `abort-slot.test.ts`'s killed-worker test, its unscaled 1 s bound at 1 357 ms. **Merged on `main` since, not pushed: `test/abort-slot-held-wait`**, which replaces that bound by the cause (the boot stage `'waiting for a held file'`, absent), red on Chrome with the slot cut (`mem:history/2026-10-19-to-25`). **Pushed 2026-10-26 (`main` at `01616d4`): CI and the matrix (23/23) green, and `tests-windows.yaml` green (run 40304959359: Test 10:09-10:38, Conformance after), `abort-slot` included.** The three other unscaled 1 s bounds of `abort-slot.test.ts` (abort latency) passed on Windows and are left as they are. The six throwaway worktrees of the session are removed; on the fork, the worktrees and branches of the merged #382, #384 and #385 were deleted on 2026-10-26 (local and `origin`, user), with the tag `backup/idb-factory-prefix-7805bb2f`. Left on purpose: `probe/stock-browsers` and `probe/webkit-opfs` (the fork's main clone `.work/wa-sqlite`, 13 uncommitted probe files of 2026-10-05) until the WebDriver PR is sent (`mem:follow-ups`), and `feat/trace-v2` (2026-09-28, no PR) awaiting the user's call. Measurements of the step loop in the library: STEP-ASAP-LIB (`mem:measurements/step`).
- **Safari is wired into the suite on `feat/safari-suite` (2026-10-22)**: opt-in, macOS only, both macOS workflows test `chrome,firefox,safari` (`mem:history/2026-10-19-to-25`). Its first runs fail 7 tests per OS, all a killed worker's held OPFS file (`InvalidStateError`, SAFARI-LIB-SUITE in `mem:measurements/test-browsers/library`). **`fix/safari-held-file` (merged 2026-10-23)** matches WebKit's `InvalidStateError` for a held file and skips the four tests WebKit 328618 breaks (`terminate()` lets a worker's WASM loop run on; reported by the user). **`fix/safari-second-client` (merged 2026-10-23)**: `second-client`'s hang on Safari was the test's — Safari delivers no event dispatched on a terminated `Worker` (SAFARI-DISPATCH-TERMINATED); green on Safari 26 and 27. **`fix/safari-restart-budget` (merged 2026-10-23)**: the whole suite green on Safari 26 and 27 with Chrome and Firefox beside it (SAFARI-WASM-INSTANTIATE; `mem:history/2026-10-19-to-25`). **`feat/safari-busy-terminate` (merged 2026-10-23)**: a killed worker's statement is interrupted through the slot under isolation; elsewhere the replacement waits for the held file up to `openTimeout`, then fails with an explicit `WORKER_CRASHED`. WebKit 328618's remainder is tracked in [issue #10](https://github.com/lalexdotcom/browser-sqlite/issues/10) (`mem:follow-ups/safari-suite`). Later: the Windows/macOS workflows in the release (user, 2026-10-15).
- **The next release is the user's call.** `[Unreleased]` over `1.0.0-rc.10` has **Breaking** entries (`stream()`/`chunk()` throw an invalid argument from the call; the transaction's methods reject a bad argument and its read methods refuse writes; the `timeout` of `stream()`/`chunk()` counts from the call), the wa-sqlite bump and the `'waiting for a held file'` boot stage among the rest; `package.json` stays at `1.0.0-rc.10` until the bump. Procedure: `mem:conventions/releasing`.
- **Left for GitHub to prove, at the next release:** the release's `prior` job and its `release`/`pages` conditions, `consumer-smoke`, and the release calling `ci.yaml`, which now calls `tests.yaml` (one more level of reusable workflow).
- **macOS 27 runs on the `xcode-27` preview image:** move `tests-macos-27.yaml` to `macos-27` once GitHub has that label (`mem:stack-and-build/ci`).
- **No slowdown (checked 2026-10-26):** the "491-498 s" of 2026-10-21/22 was the merged report's `Duration` line, the SUM of the 19 jobs' durations, not wall time. `time pnpm test` (`node scripts/test-plan.ts --unit`) gave 2 min 55 s wall, build included, with `Duration 525.54s` printed; the delivery gate's run spanned 147 s from `plan.json` to the last job log — the 143 s baseline below, at 6 processes.
- **The container rebuild waits for the user:** `post-create.sh` on a fresh container (`node scripts/browsers.ts install` prints two `ok`, actionlint installs, `pnpm test` green). The Vitest + WebdriverIO design: `docs/superpowers/specs/2026-10-10-vitest-webdriverio-design.md`.

## In flight, and not ours to move

- **wa-sqlite's tests on stock browsers: the WebDriver PR is ours to send.** A revised proposal
  was posted on Discussion #373 on 2026-10-08; he questioned the move away from Playwright on
  2026-10-10, was answered the same day, and accepted it that evening ("let's see what a WebDriver
  PR looks like", CI triggers on Linux only for now) — unrecorded until 2026-10-14. It covers
  WebDriver instead of Playwright, a DataView race in the harness, and a skip for Safari 26. The
  plan and what his go calls for are in `mem:follow-ups`, the
  measurements in `mem:measurements/test-browsers`, and the user's principles in
  `mem:conventions` (§ Testing in browsers).
- **Our open PRs on wa-sqlite (2026-10-24): #386, #387, #388**, all carried in the patch. #388 (`step_asap()`, #383's options 1 and 2, opened 2026-10-23): changes requested 2026-10-25 and replied the same day, `allowed`'s "costs nothing" taken back (Firefox +7 %); the revision is prepared and committed locally, not pushed (`34d46069` on `step-asap`, `.work/wa-sqlite-step-asap`), and waits for his answer (user); it keeps the API and regenerates the patch with the rebuilt glue (`mem:follow-ups/wa-step-upstream`). #387 and #386 as below. Merged on 2026-10-23: #381 (`8a8bc2ee`), #382 (`010eeb50`), #384 (`ced5652e`), #385 (`66336807`), all pinned. When one merges, repin and drop its hunk (`mem:stack-and-build/wa-sqlite`, `mem:upstream`).
- **#386** (`OPFSCoopSyncVFS` startup sweep, issue #362, 2026-10-23) was rebased onto `8a8bc2ee` (`c4f832ea`); **#387** (`getIDBFactory`/`prefix` for the IndexedDB VFS, offered on #380, 2026-10-23) is unused here; rebased onto `66336807` on 2026-10-25 (`516b3080`), awaiting review.
- **Another agent's work was paused by the user until our upstream PRs were done; the user
  relaunches it.**

## Trusted publishing — done (2026-10-19), nothing left

- **Shown at rc.8 (2026-10-09): OIDC alone publishes AND moves the dist-tags.** The release job ran
  with `NODE_AUTH_TOKEN` empty; `npm publish` signed provenance and `npm dist-tag add` set
  `latest` and `next` (`+latest: browser-sqlite@1.0.0-rc.8` in the log), and the registry reads
  all three tags at rc.8. The open question of rc.7 is answered.
- **Done 2026-10-09:** the package's publishing access is "disallow bypass 2fa tokens" (user),
  and `release-and-publish.yaml` no longer has an `npm-token` input, even commented out.
- **Done 2026-10-19:** the `NPM_TOKEN` repository secret is deleted (user; `gh secret list` empty). Nothing is left to do on trusted publishing.

## Known live exposures

**`1.0.0-rc.10`, the published version, carries every defect that `[Unreleased]` lists as Fixed** until the next release, among them: the last write before `close()` lost about half the time on `IDBBatchAtomicVFS` with `synchronous=NORMAL`; an IndexedDB database left held open on Safari after `close()`, `deleteDatabase()` or a terminated worker; `OPFSCoopSyncVFS` and `OPFSAdaptiveVFS` (Firefox) failing or hanging after another client's worker was terminated; a crash restart failing the client on `OPFSAdaptiveVFS` in Firefox; `wasmUrl` ignored for the `.wasm`. The list is the CHANGELOG's, not repeated here.

## Settled — do not reopen without new information

- **`RECOMMENDED_VFS`** was answered on 2026-09-08 by medianing the bench corpus at n≥3 per
  platform (VFS-MEDIAN): two recommendations, `OPFSWriteAheadVFS` and `OPFSAdaptiveVFS`, and the
  list left `src/` (`mem:vfs`, `mem:history/waves`).
- **HANDLE-2 was closed by the user on 2026-09-21 as a misattribution** (`mem:vfs`); the one
  candidate that survives is the single-shot `onmessage` listener in `OPFSCoopSyncVFS.jLock`.
- **wa-sqlite #341 is settled for us (2026-09-29):** its trigger needs two calls in flight in one
  module, which rhashimoto ruled outside the supported case and the library never does
  (`mem:architecture`); no PR, no patch (RETRY-OPS, `mem:measurements/wa-sqlite-prs`).

## Unmeasured ground — what a claim here would be inventing

- **No engine beyond Chromium, Firefox and the Apple devices measured** (the four of 2026-08-27,
  and Safari 26/27 since). `OPFSWriteAheadVFS` on Safari gives no concurrency, so it earns a
  Safari user nothing.
- **`deleteDatabase` is measured on six devices and times out on two VFS off Chromium**, n=1 per
  device; in Known Limitations since 2026-08-27 as an observation, in those words.
- **Nothing in this repo reproduces a pool that never frees a worker.** Chromium always does, so
  the suite stayed green through three real abort defects. The benchmark page is the reproducer
  and a device campaign the verification (`mem:lessons`).
- **n≥3 per device before citing a flip.** `survives-reopen` was believed to flip and does not
  (REOPEN-1, closed 2026-09-03); `no-read-inside-transaction` does not flip at n=3 per engine
  (`mem:measurements/scheduler-and-pool`).
- **Absolute OPFS timings taken under rstest (before 2026-10-10) are inflated**, its pages being
  off-the-record (RSTEST-OTR); what the WebdriverIO suite's profile costs per call is unmeasured.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped,
`mem:measurements` for every number this project owns.
