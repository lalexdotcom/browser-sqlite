# State — where the work stands

**Updated 2026-10-13.** Rewrite this whole file when it stops being true; do not append a
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
- **The vendored wa-sqlite sits on upstream `master` of 2026-10-13** (`6238f532`, #374 merged;
  `package.json` has the SHA; the built worker, the `.wasm` and `index.js` are byte-identical to the
  previous pin's). **No patch since then**: every change the library carried has merged upstream,
  and `patches/` and `patchedDependencies` are gone. Heads and merges in
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

- **Done, awaiting the final review and the user's approval to merge (2026-10-15): the library's tests on Windows and macOS in CI, dispatched on demand — branch `ci/windows-macos`.** Spec `docs/superpowers/specs/2026-10-14-ci-windows-macos-design.md`, plan `docs/superpowers/plans/2026-10-14-ci-windows-macos.md`. Three green runs per platform (LIB-WIN-MAC, `mem:measurements/test-browsers`); what it built is in `mem:stack-and-build/ci` and `mem:conventions` (§ What runs where, `BSQ_TIME_SCALE`). Pushed for the runs (the user's go covered that); `main` not pushed.
- **Next, in this order (user, 2026-10-15):** (1) carry wa-sqlite #381 (opened 2026-10-15, `docs/upstream/2026-10-15-wa-sqlite-381-coopsync-held-handle.md`) as a `pnpm patch`, on its own branch off `main`, with a CHANGELOG entry and the matrix; (2) one Windows run with `coopsync-handover`'s three tests re-enabled, to see only the 30 s `TIMEOUT`s remain; (3) `OPFSAdaptiveVFS`'s hand-over, which may have #381's race and leave its lock held (`mem:follow-ups`); then `browsers.ts` as the only installer under an inter-process lock; later, the Windows/macOS workflows in the release.

- **The Vite dep-optimizer race between parallel Vitest processes is fixed and merged (2026-10-13)**: one cache per job (`mem:follow-ups/notes`). CI's `verify` was the exposed run (conformance in 2 shards per project on a cold cache); the push that carries the fix is its proof.
- **Done and pushed (2026-10-13):** the test planner (plans A, B, C; the matrix plans first and runs on every push of `main`), and the test-triggers review (`docs/superpowers/specs/2026-10-13-test-triggers-design.md`: hooks per change, actionlint, the release reusing the push-of-`main` runs, publint/attw, the Pages bench check; `mem:conventions` § What runs where). CI 38441033562 and matrix 38441033564 green on the push. **Left for GitHub to prove:** the release's `prior` job and its `release`/`pages` conditions and `consumer-smoke` at the next release. The Pages bench check is proven (run 38448872714, `preview` moved to `e5855bb` on 2026-10-13).
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
- **No PR of ours is open on wa-sqlite since 2026-10-13**: #371 (2026-10-10), #372 (2026-10-11) and #374 (2026-10-13) merged and left the patch at the repins (§ Standing facts). #362 (an upstream issue) awaits the user's decision on a PR; `mem:follow-ups`.
- **Another agent's work was paused by the user until our upstream PRs were done; the user
  relaunches it.**

## Trusted publishing — what is left, all the user's

- **Shown at rc.8 (2026-10-09): OIDC alone publishes AND moves the dist-tags.** The release job ran
  with `NODE_AUTH_TOKEN` empty; `npm publish` signed provenance and `npm dist-tag add` set
  `latest` and `next` (`+latest: browser-sqlite@1.0.0-rc.8` in the log), and the registry reads
  all three tags at rc.8. The open question of rc.7 is answered.
- **Done 2026-10-09:** the package's publishing access is "disallow bypass 2fa tokens" (user),
  and `release-and-publish.yaml` no longer has an `npm-token` input, even commented out.
- **Left, the user's:** delete the `NPM_TOKEN` repository secret. Nothing reads it any more; it
  **runs out around 2026-11-29** anyway (renewed for 90 days at rc.4's release, user 2026-09-05;
  derived, not read off npm).

## Known live exposures

None known since rc.8: the breaking change and the Firefox memory fixes that sat in
`[Unreleased]` shipped with it.

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
