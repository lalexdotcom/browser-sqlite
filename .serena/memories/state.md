# State — where the work stands

**Updated 2026-09-21.** Rewrite this whole file when it stops being true; do not append a
new dated section under the old one.

**No SHAs, no commit counts, no branch names here (user, 2026-08-27).** `git log`,
`git status` and `git branch` answer all of that in one command and always correctly, while
a copy here rots — it did three times in a single day, on the same file, naming a stale
HEAD, a stale count and a conformance result that a fix had already changed. `mem:index`
already says it: these memories carry what cannot be re-derived. This file is decisions,
obligations and unmeasured ground.

## Standing facts about the repository

- **`1.0.0-rc.4` is published**, on 2026-08-31: on npm under `rc`, `next` and `latest`, and
  as a GitHub prerelease whose body is the CHANGELOG section for the tag. `package.json`
  sits at `1.0.0-rc.4` and stays there until the user calls the next bump; everything since
  lands in a new unreleased section of `CHANGELOG.md`, which **the user's instruction
  creates** — no automation opens one.
- **Pushing is still not part of committing** (`mem:conventions`), and `main` may sit ahead
  of `origin/main` indefinitely. It was pushed on 2026-08-31 because a release needs the
  remote to carry the tagged commits, not because the convention changed. Do not push as
  housekeeping.
- **Feature branches are merged with `--no-ff`** and a body explaining the change, matching
  every previous merge.

## The verification baseline — compare against these, re-measured 2026-09-21 after the wa-sqlite repin

Not history: the numbers a regression is detected against. **Every figure below was read off a run
in this container on 2026-09-21, on `main` with wa-sqlite repinned to upstream `93b9230`** — none is
carried forward, none is arithmetic. The whole table was read in ONE pass, which is what its own
rule demands, and that pass is what caught the previous version contradicting itself: its prose said
`pnpm test` 1181 / 676 / 14 while its own table row still said 1175 / 670. A cell had been patched
and the table had not been re-read.

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm build` | clean |
| `pnpm test` | **THREE reports**, `status: pass` on each: **1181 tests / 77 files** (unit + the two chromium target projects, **8 skipped**), **676 / 51** (the two firefox target projects, **2 skipped**), **14 / 3** (the two isolated target projects, none skipped) |
| `pnpm exec rstest --project unit run` | 507 tests, 27 files |
| `pnpm exec rstest --project 'chromium*' run` | the two chromium target projects; the glob is required since 2026-09-15 — project names are now `chromium · <vfs>/<build>` and rstest's filter is anchored |
| `pnpm test:conformance` | **TWO reports** — 85 tests / 2 files each: **Chromium 71 passed / 14 skipped, Firefox 67 / 18** — they differ by design since 2026-09-14 |
| `pnpm exec biome ci .` | exit 0 |
| `pnpm docs:vfs` | leaves `VFS.md` unchanged (`git diff --exit-code`) |
| `pnpm test:consumer` | 24/24 stages |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` | `OK`, `"reasons": {}`; the checker requires `poolSize` and `longQueryCalibration` among the keys. `bench:build`, not `build`: the checker serves `_site/`. Pass `BENCH_PORT` to leave 8099 to `bench:serve` |
| `pnpm lint` | 137 files, 13 warnings, 1 info — **136 until the repin pass**; the file count moves with the tree, the warning count is the signal |
| `dependencies` in `package.json` | absent |
| `pnpm test:matrix` | **66 of 66 cells green, 0 failing tests, 2486 s** on this pin. ~40 min. Its per-cell detail is `mem:measurements`, MATRIX-5 and after |

Against the morning's table on the previous pin — the same `pnpm test` 1181 / 676 / 14, the same
conformance, matrix 66 of 66 in 2650 s — **nothing moved but the matrix's wall clock**, which is not
a regression signal. That is the whole point of having run it: wa-sqlite #330 and #355 changed a
vendored dependency that is bundled into `dist/worker/worker.js`, so `build`, the consumer smoke and
the bench checker were run for the same reason as the tests.

Against 2026-09-18's table — `pnpm test` 1173 / 674 / 14, matrix 65 of 66 with 1 failing test —
chromium gained 8 and firefox 2, and conformance moved to 85 per engine. **Do not reconcile any of
these by arithmetic; re-run.**

A previous version of this table was measured on 2026-09-15 and went stale the next day: the branch
stopped every test file from enumerating VFS, which took `pnpm test` from 1554/1038/14 to
1173/668/14 and the unit project from 482 to 507. It sat wrong for a day beside a prose paragraph
carrying the right numbers. **That is what "re-measure the whole table, do not patch one cell" is
protecting against — and a table known to be wrong gets re-measured, not annotated.**

**`pnpm test` chains THREE configs** — chromium+unit, firefox, and the isolated project — so a
green `pnpm test` covers what CI covers. Since 2026-09-11 a commit pays only the unit project; a merge or a push pays all three
(`mem:follow-ups`, the pre-commit hook entry).
**A green `pnpm test` is not a green tree: run `pnpm exec tsc --noEmit` beside it** — a commit
on the last branch landed with a failing typecheck that no test run could show (`mem:lessons`).

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm build` | clean |
| `pnpm test` | **THREE reports**, `status: pass` on each: **1175 tests / 76 files** (unit + the two chromium target projects, **8 skipped**), **670 / 50** (the two firefox target projects, **2 skipped**), **14 / 3** (the two isolated target projects) |
| `pnpm exec rstest --project unit run` | 507 tests, 27 files |
| `pnpm exec rstest --project 'chromium*' run` | the two chromium target projects; the glob is required since 2026-09-15 — project names are now `chromium · <vfs>/<build>` and rstest's filter is anchored |
| `pnpm test:conformance` | **TWO reports** — 85 tests / 2 files each: **Chromium 71 passed / 14 skipped, Firefox 67 / 18** — they differ by design since 2026-09-14 |
| `pnpm test:consumer` | 24/24 stages |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` | OK, empty `reasons`; the checker requires `poolSize` and `longQueryCalibration` among the keys. `bench:build`, not `build`: the checker serves `_site/`. Pass `BENCH_PORT` to leave 8099 to `bench:serve` |
| `pnpm lint` | 136 files, 13 warnings, 1 info |
| `dependencies` in `package.json` | absent |
| `pnpm test:matrix` | **not in this table on purpose** — 66 cells, ~50 min, and failures are expected. Its baseline is `mem:measurements`, MATRIX-5 |

**The browser skips are expected: 4 per Chromium project, 1 per Firefox project.** Each config
now builds ONE project per target, so the table's per-config totals are twice those: **8** on the
chromium report and **2** on the firefox one. Count per project before comparing. One, on both, is
`tests/browser/abandon-gc.test.ts`: it pins the `FinalizationRegistry` path and needs
`--expose-gc`, which cannot go into `rstest.config.ts` without changing the launch arguments every
other browser test runs under, so it skips under `pnpm test` and in CI and its header carries the
CLI override that runs it. The three more on Chromium are `pool-cap.test.ts`'s capped-engine
tests — the effective size after a loss, the retry-round decline, the total failure at `poolSize`
4 — which skip where `readwrite-unsafe` exists. **Any other count is something to look at.**

**The per-project split is here on purpose.** A total alone cannot say which suite moved, and
the totals are what rot: this file carried "the browser project is 158/158" from 2026-08-28
until 2026-09-02, by which point the same command was reading well over two hundred — several
rc.5 lots had added browser tests and nobody re-read the line. **Re-measure the whole table
when you touch it; do not patch one cell.**

**Read four fields from a test report, not three.** `status` and `failedFiles`
show an unhandled rejection escaping outside any test, which the per-test
counters cannot. That was reported green once — see `mem:lessons`.

Firefox conformance was 57/19 until `OPFSWriteAheadVFS`'s declaration was corrected. **Since
2026-09-14 the two engines no longer agree, by design:** on Firefox two invariants skip
`OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which run one worker there (`oneWorkerHere` in
`tests/conformance/helpers.ts`). Any other divergence means something skipped that should not.

**Firefox is a CI gate since 2026-08-28, and since 2026-09-03 it is inside `pnpm test`**
rather than a step of its own — `TEST_BROWSER` is gone, and a local run covers what CI covers. The two flakes this file used to warn about are gone: `long-query :: does not
block the pool` was never a pool defect (it timed the FILE — see `mem:follow-ups`), and
`barrier` did not reproduce in 13 consecutive runs. **A failure on the Firefox step is
signal, not noise** — it is the only step without `readwrite-unsafe`, so it is where a
reduced-mode regression lands first. Since 2026-09-14 it no longer drives a pool against a rotated
handle within one client (`OPFSAdaptiveVFS` runs one worker there); the rotation is exercised
between clients. The 13-run campaign was
one machine and one build; slower CI hardware may still surface timing the campaign did not.

## Decisions the user owes

- **The second-client subject is CLOSED and MERGED** — `5661048`, 2026-09-18, `--no-ff`, branch deleted
  local and remote. What the user set
  the session on — the multi-client and cross-tab tests on every VFS — grew into the branch that ships:
  `exclusiveConnectionWithout` and the guard that answers a second `OPFSWriteAheadVFS` client with
  `DATABASE_IN_USE` where the engine lacks `readwrite-unsafe` (it used to fail every query with
  `WORKER_CRASHED`, and could break the FIRST client instead); `BEGIN IMMEDIATE` for write transactions,
  which is what `OPFSWriteAheadVFS` requires and what `output()` was failing on; the second-client matrix
  over every (vfs, build) pair; `multi-client`/`cross-tab` on every VFS that shares; and the whole browser
  suite following an injected (vfs, build) target, with `pnpm test` covering both recommended pairs and
  `pnpm test:matrix` covering all 22. Design and its amendments A1-A5:
  `docs/superpowers/specs/2026-09-15-second-client-design.md`.

  **Where it stood at the end of 2026-09-16, for a cold restart.** The branch then also carried: the
  whole browser suite freed of VFS enumeration — no test file loops over VFS any more, a file states
  what its subject needs (`two-workers`, `interruptible`, `shared-second-client`) and the matrix
  supplies the pairs (spec amendment A6); `db.inspect()` and `detectFeatures` following the target
  (they had never run outside one pinned VFS); and two guards against a run that sits for ever —
  the conformance probe bounded with retries, and `scripts/bounded.mjs` giving every browser script
  a deadline. Verified whole on 2026-09-16: `pnpm test` 1173/668/14, unit 507, conformance 85 per
  engine identical to baseline, `tsc` clean, and a full `pnpm test:matrix` (MATRIX-2, 2386 s) with
  no timed-out cell.

  **THE TRIAGE IS FINISHED, tests and product alike (2026-09-18).** Three commits took the matrix
  from 989 cell-failures to 79: the browser cleanup that never ran (`mem:lessons`), the pinned
  `poolSize: 2` becoming `needs: ['two-workers']`, and the two new needs the user validated
  (`shared-storage`, `opfs-file`). A fourth fixed the product defect those cleared tests exposed
  (HANDLE-CORPSE). **Then 2026-09-18 took the remaining three product piles to zero: the full
  matrix read 65 of 66 cells green, 1 failing test, 1 group** — against 62 cell-failures and
  20 groups on 2026-09-16 — and that one was a load flake, fixed by `2be2ae6`. **The matrix has read
  66 of 66 since 2026-09-21** (§ the verification baseline).

  **Every one of the three traced to wa-sqlite, not to this library**, and each went upstream with
  a test failing on wa-sqlite's own master: #350 and #351, #352 and #353. Our own share was two
  changes — `deleteDatabase` deciding presence from the OPFS entry rather than from an open probe,
  and a retry around `sqlite3_open_v2` gated by a new `exclusiveFileHandle` capability
  (`mem:vfs`). The patch now carries five PRs over three files (`mem:stack-and-build`), reports in
  `docs/upstream/`.

  **One decision is still owed and it blocks nothing: HANDLE-2's verdict** (§ below). The merge was
  given on 2026-09-18.

  The Firefox silent hang that blocked runs is diagnosed and guarded, not cured:
  `navigator.storage.getDirectory()` can fail to settle in a worker on Firefox.

**rc.5 does NOT ship with the open subjects below (user, 2026-09-09).** Said of two subjects,
and both are now closed — the second by merge `eeabe06` on 2026-09-11.

- **HANDLE-2 was investigated the same day and came apart** — its stated cause is measured
  false and the wedge does not reproduce anywhere, on `main` or before the fix (§ below).
  What produced its symptom was a write-lock defect, now fixed and merged.
- **The short-circuited-statement defect is FIXED and merged** (2026-09-10, § below). What was
  described here as a `tx.first()` defect was four faces of one mechanism.
- **The per-statement `timeout` inside `transaction()` is fixed and merged** (2026-09-11,
  merge `eeabe06`, § below). What it exposed — an interrupted write inside a transaction,
  and a `tx` handle outliving its transaction — was fixed on the same branch.

The user's words were general — *"on ne sort pas la RC5 avec ce genre de sujets pas réglés"* —
so **treat this as the subjects that were in front of them, not as proven exhaustive**: confirm
the scope before planning the release. The write-lock defect is itself the proof, since it was
found only by going looking.

**The reason, and it is a triage rule rather than a list (user, 2026-09-09): rc.5 must be as
close to stable as possible, and stability and reliability are rc.5's job.** One feature
addition is planned for rc.6, which the user will come back to. So the question to ask of
anything discovered from here is not "is it on the list" but "is it reliability" — if it is, it
belongs in rc.5, and a feature does not.

**The CI gate holds since 2026-09-15** (the gate is the user's, 2026-09-05). `main` was pushed
that day for the first time since rc.4, and it took three runs. The first stopped at *VFS table is
current* — a hand edit inside a generated span (`mem:lessons`) — before any test ran; the
`pre-push` hook now runs that check. The second reached the tests and lost two in
`query-timeout.test.ts` on Firefox, a bound calibrated on this machine exactly as this paragraph
feared (CI-QUERY-TIMEOUT, `mem:measurements`). **Run 34953847713 at `7cf2944` is green end to
end**: biome, the table, `tsc`, build, `pnpm test` (4 min 39 s on the runner), conformance on both
engines (27 s) and the consumer smoke (55 s). The user judges the release ready — the bump itself
remains an instructed act, never an inferred one. **That judgment predates two findings of the same
afternoon** — the CoopSync hand-over and the `OPFSWriteAheadVFS` second-client refusal — and both have
been fixed and merged since. The commits since have not been through CI: `main` is not pushed.

**One thing to expect on CI, and it is not a defect.** The abandoned-generator
work found a defect that reproduces about once in eighteen runs of `pnpm test` and **never**
in isolation — it needed the full chain, and it turned out to be load-sensitive. It is fixed,
but the shape is the warning: **a Firefox browser test that fails once on CI and passes on a
re-run is not automatically noise here**, and the cheap way to tell is sixteen busy loops
around a single-file Firefox run, which cut time-to-failure twentyfold (`mem:measurements`,
ABANDON-WEDGE).

**A third gate is closed: the README was reworked on 2026-09-07** (§ below), which is what
the 2026-09-05 entry in `mem:follow-ups` called for.

**Nothing is in flight, and the work is on `main` (2026-09-21).** The second-client branch merged on
2026-09-18; everything since is documentation. `main` sits ahead of `origin/main` — the convention,
not an oversight.

**The subject the user set on 2026-09-21 — the two `OPFSCoopSyncVFS` opens that failed on chromium — is CLOSED, and it was closed before it was started.** `mem:follow-ups` still described it as HANDLE-CORPSE on a path the retry misses; that entry had rotted. The cells failed at MATRIX-5 (2026-09-18 08:25) and the two fixes landed at 13:33 and 13:34 the same day: wa-sqlite #350 (the partial acquisition that leaks the handles beside the one that failed, which is what made every retry fail on `-journal`) and `exclusiveFileHandle` + `openWithRetry` on our side — `OPFSCoopSyncVFS` **is** declared `exclusiveFileHandle: true`, so `sqlite3_open_v2` does get the retry. Verified by measurement rather than by reading: eight consecutive runs of that cell, 8/8 green, plus the two full matrices since (COOPSYNC-OPEN-CLOSED, `mem:measurements`).

**What survives of it is diagnosability, and only that:** `jOpen`'s asynchronous phase never sets `this.lastError`, so an open blocked by a dead context is indistinguishable from a missing file. One line upstream, both consumers already in place, unscheduled — `mem:follow-ups`. Everything else there stays unscheduled but the default build, scheduled for rc.6. Upstream, rhashimoto/wa-sqlite#347 is open (§ Pending).

**HANDLE-2 was investigated on 2026-09-09 and came apart under measurement.** Its stated cause
is false — Firefox releases a killed worker's sync access handle in 1-6 ms (HANDLE-ORPHAN) — and
the wedge itself does not reproduce: ~70 attempts on `main` in six shapes, and **0/40 at the
pre-fix commit on the very VFS where 9/40 was recorded**. Details and the failed reproductions:
`mem:vfs`, HANDLE-2; `mem:measurements`, "HANDLE-2 does not reproduce".

**The verdict on the entry is the user's and has NOT been given.** Do not close it, and do not
present it as a live defect either. Two things are established and neither of them is a verdict:
the engine is not the cause, and nobody holds a reproduction. What produced its symptom —
permanent, silent, origin-wide — was found and fixed the same day (§ below).

**The `RECOMMENDED_VFS` question is settled and must not be reopened.** It was answered on
2026-09-08 by medianing the bench corpus at n≥3 per platform (`mem:measurements`,
VFS-MEDIAN). The answer was not "move it": there are now **two** recommendations,
`OPFSWriteAheadVFS` and `OPFSAdaptiveVFS`, and the constant itself left `src/` — see § below.

## `OPFSCoopSyncVFS` hands its handle over between calls only — merged 2026-09-15

No spec: investigated with systematic debugging, the fix designed in chat and approved. Numbers in
`mem:measurements` (COOPSYNC-HANDOVER); the VFS fact in `mem:vfs`; the pin and the patch traps in
`mem:stack-and-build`. The fix is a wa-sqlite patch, proposed upstream as rhashimoto/wa-sqlite#347.

**Five things the code will not tell you:**

- **The cause is a re-prepare, not the protocol step COOPSYNC-BUSY named.** SQLite locks, unlocks
  and locks again inside one `step` when a cached statement's schema changed; the VFS released at the
  inner unlock; `retry()` tries twice. The 2026-09-03 read failures were the same mechanism, which
  `readWithRetry` absorbed; nothing produces them now and no test exercises that retry — fine by the
  user: the red-to-green test is what counts.
- **A task, not a microtask.** The JSPI build suspends at every VFS call; the microtask version was
  reasoned safe and measured wrong (`mem:lessons`). `coopsync-handover.test.ts` runs on `jspi` for that
  reason, and its mutation back to a microtask is recorded.
- **wa-sqlite is pinned by SHA (user).** Vendored, so a commit serves as well as a release: upstream
  HEAD `07ad48c` at the time — `93b9230` since 2026-09-21 — which carries #344, so the patch held the
  CoopSync change only, under the key
  `wa-sqlite@1.1.2`. When #347 merges, repin to its merge commit and delete the patch.
- **#347's evidence is wa-sqlite's own suite, never this library** (user: a stable library is not
  argued from an unstable one — `mem:conventions`). Its `jspi` claim rests on our measurements: that
  suite skips `jspi` on current Chrome.
- **The same probe found the next subject.** `OPFSWriteAheadVFS` refuses a second client off
  Chromium, and the multi-client and cross-tab suites run on `OPFSAdaptiveVFS` alone
  (`mem:follow-ups`) — the next session.

**What it does NOT deliver.** Nothing for `OPFSWriteAheadVFS`. The NotFound fix rests on a small
natural sample (2 of 19 against 0 of 20) and on a test that forces the race with 30 orphaned
directories.

## Statement errors — merged 2026-09-15

Spec `docs/superpowers/specs/2026-09-14-statement-errors-design.md` — read its decisions D8-D10,
the user's amendments while it was built, and not only the first version. Plan
`docs/superpowers/plans/2026-09-14-statement-errors.md`; its code predates D10 and the final fix
wave, so the spec and the source are what is current. Merge `54c4492`.

**Four things the code will not tell you:**

- **Why `sqliteCode` is strict and `sqliteExtendedCode` open (D10).** The strict type makes
  `err.sqliteCode === SQLITE_EXTENDED_CODES.X` a compile error. The open one exists because the
  client deliberately lets a wrong read through (D9) — a 0, or 101 after a JS-side `MISUSE`. Do not
  tighten the extended type, and do not turn `subtypeOf` into a `>= 256` filter: either would hide
  a wrong read.
- **The stamp's three sites are an invariant, not a style** (`mem:architecture`).
- **`sqliteCodeOf` is why an open refused by OPFS carries no `sqliteCode`.** Before it, any
  numeric `code` crossed the boundary, and a DOMException's legacy code is numeric.
- **D10 rests on a measurement, not an assumption**: TypeScript's completion does offer numeric
  literals (5.9.3, 6.0.3), and `number & {}` keeps them from collapsing into `number`
  (`mem:stack-and-build` says how to probe it under TS 7).

**What it does NOT deliver.** No extended code at open or delete (D7); no named code per
result-code family (D1). A later statement's prepare failure in a fresh multi-statement string is
stamped by a site no test can falsify. `SQLITE_CODES` is re-transcribed by hand when wa-sqlite moves
to another SQLite.

## `IDBBatchAtomicVFS` during a long statement — merged 2026-09-14

No spec: a bounded fix, designed in chat and approved. Numbers in `mem:measurements` (IDB-SIGNAL);
the VFS fact in `mem:vfs`; what is left in `mem:follow-ups`.

**Five things the code will not tell you:**

- **The bench measured the library's option, not the VFS.** Its long query carried the row's
  signal; when a signal started reaching the worker (`f4b3fd7`), the verdict flipped with no change
  to the row. It now issues the long query bare (`mem:lessons`).
- **`yieldsDuringStatements` is about IndexedDB, not about the handle.** `jLock` opens a readwrite
  IndexedDB transaction per statement, which commits only when the worker returns to its event loop.
  The yield runs on every statement of that VFS and stops one only when it is abortable.
- **The calibration verifies only a bound it did not time.** Re-running a timed bound ran Safari's
  `async` build down its slowdown and voided the IDB column; `longQueryCalibration` exports every
  timing, so a `null` explains itself.
- **On Safari the `async` build degrades and stays slow; `jspi` escapes it on 27.** `VFS.md` says
  so under *Build `async`*; the default build moves to the first supported one in rc.6.
- **Measure Safari from the container.** The user opens `localhost:8099`, served from `_site`
  (`mem:conventions`); Playwright's Linux WebKit cannot stand in, its workers do not even load.

**What it does NOT deliver.** Safari 26 has no way around the slowdown for a VFS without a `sync`
build. The bench's `async` columns stay `null` on Safari whenever the slowdown has set in — honest,
not fixed. `OPFSAdaptiveVFS` on `jspi` was never measured on Safari 27.

## The pool capped by its environment — merged 2026-09-14

Spec `docs/superpowers/specs/2026-09-13-pool-environment-cap-design.md` — read its §9 and §10
amendments; plan `docs/superpowers/plans/2026-09-13-pool-environment-cap.md` (Tasks 1-13).
Merge `121b0f6`. Invariants in `mem:architecture`; numbers in `mem:measurements` (WORKER-LOST,
POOL-SIZE, DELETE-WA); VFS facts in `mem:vfs`.

**Six things the code will not tell you:**

- **The observation was a VFS design fact the repository once had right.** Off Chromium,
  `OPFSWriteAheadVFS` keeps its file exclusively for a connection's life; `70b2b7a` (2026-08-27)
  "refuted" that on a conformance pass that never counted workers. Conformance now fails on a lost
  worker and skips a two-worker invariant where the pool runs one (`mem:lessons`).
- **The decisions are the user's (spec D1-D11):** a capped pool is capped, not lost; the warning
  fires only on an explicit `poolSize`; a `db.poolSize` getter, not a callback; every surplus worker
  probes and declines itself; `WorkerLostEvent.size` is the effective size; `db.ready` is rc.6;
  `singleConnectionWithout` means "a pool beyond one buys nothing" and covers `OPFSAdaptiveVFS`;
  `OPFSCoopSyncVFS` has `maxPoolSize: 1` everywhere — **breaking, accepted**.
- **The probe reads the `mode` ATTRIBUTE inside a worker.** The page cannot probe:
  `FileSystemSyncAccessHandle` exists in dedicated workers only, and a probe worker of its own would
  still answer asynchronously and meet a consumer CSP without `worker-src blob:`. Passing the
  dictionary option proves nothing — WebIDL ignores it. Do not "simplify" either way.
- **The Firefox config no longer drives a pool against a rotated handle within one client.**
  `OPFSAdaptiveVFS`, `createTestClient`'s default, runs one worker there; the fifteen tests that
  need two workers run on `OPFSAnyContextVFS`, and rotation is exercised only between clients.
- **Conformance no longer agrees across engines, by design** — Chromium skips 14, Firefox 18: on
  Firefox two invariants skip `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which run one worker there.
- **The bench still shows the declared pool** in its column header and burst normalisation; the
  export records `db.poolSize`. The header waits for `db.ready` (user, `mem:follow-ups`). Since
  2026-09-14 it skips **three** rows on a one-worker column, not the two its commit message names:
  `reads-during-long-query` too — whether the other workers serve during a long query has no
  subject on one worker. So the bench no longer shows HANDLE-1 within a client off Chromium.

**What it does NOT deliver.** Safari is checked at n=4 on one Mac and Firefox at n=3 in this
container (SAFARI-CAP, `mem:measurements`): every cap holds. CoopSync writes can still take the transfer BUSY between clients; `barrier.test.ts` does
not guard the barrier; D-09 has no falsifier by construction (`mem:follow-ups`). Orphan
`-wa0`/`-wa1` files left by deletions before the fix stay — harmless, by decision.

## The caught write abort — merged 2026-09-12

Spec `docs/superpowers/specs/2026-09-11-tx-savepoint-design.md` (read its dated amendment in §4),
plan `docs/superpowers/plans/2026-09-11-tx-savepoint.md`. Branch `fix/tx-savepoint`, merge
`65a40d3`. Invariants in `mem:architecture`; numbers in `mem:measurements` (TX-SAVEPOINT,
TX-M1M2).

**Five things the code will not tell you:**

- **The rule is the user's, stated as use cases.** *"Je catch une erreur et je continue"* is
  normal: a statement abandoned by its own `signal`/`timeout` has no effect, and a callback that
  catches it goes on — SQLite's statement-level model, chosen over PostgreSQL's
  poison-until-rollback. All or nothing is what a transaction is for: the docs say "use a
  transaction", never "use `tx.bulkWrite`"; inside one, a caught error followed by a commit keeps
  what was written, `bulkWrite`'s completed batches included.
- **Approach B was the user's choice against the recommendation.** A — the transaction sending
  `SAVEPOINT`/`RELEASE` itself — was recommended for stability; the user chose B, the worker
  opening the savepoint inside the write's own message, after both were measured, holding that
  stability is what tests guarantee. Real B costs 0.016-0.019 ms per opted-in write on Chromium
  and 0.085 ms on Firefox. **Do not re-propose A on stability grounds without new evidence.**
- **The wait after a caught abort is unbounded by design (user, D3).** The next statement or the
  commit waits for the abandoned write to run to its end, with the write lock held; only the
  transaction's own `signal`/`timeout` and the waiting statement's own bound it. A `drainTimeout`
  bound and a fail-fast error code were both refused.
- **A failed savepoint conclusion rolls the whole transaction back in the WORKER**, which the
  final review added: the spec stated the rule, its test list did not, and nothing built it — a
  consumer's `…; RELEASE u` abandoned could commit a rejected write. The client learns of it
  through the existing D6 path (`inTransaction: false`).
- **What it does not deliver.** The isolated-build test does not pin that the step is actually
  CUT on a transaction death — redundant safeties keep it green under every single-cause mutation
  tried; only a timing bound would. T9 never has a batch in flight, so R4's in-flight undo is
  covered by construction only. `tx.savepoint()` is rc.6 (`mem:follow-ups`).

## The transaction closure — merged 2026-09-11

Spec `docs/superpowers/specs/2026-09-10-transaction-abort-design.md` (read its dated
amendments), plan `docs/superpowers/plans/2026-09-10-transaction-abort.md`. Branch
`fix/tx-statement-timeout`: step 1 honoured a per-statement `timeout` inside `transaction()`;
step 2 is what that exposed. Invariants in `mem:architecture`; campaigns in
`mem:measurements` (TX-AUTOCOMMIT, TX-HANDLE, TX-M1). Merge `eeabe06`.

**Five things the code will not tell you:**

- **The rule was chosen as a mechanism and corrected by the user's use cases.** "An abandoned
  write abandons its transaction" shipped through spec, plan, six tasks and a whole-branch
  review before the user wrote down what a consumer expects: a caught error goes on, an
  uncaught one stops everything. Two decisions followed, both recorded in the spec: D4
  reversed — a write whose own signal was already aborted at the call is simply rejected and
  the callback may go on — and `tx.signal` aborts on EVERY rejection of `transaction()`,
  not only an abort. The one case still off the user's model, a caught write abort while it
  runs, is the savepoint follow-up.
- **The savepoint option was refused once, and the refusal was right for what it was.** The
  version refused never cut a write, so a `timeout` bought nothing. The deferred variant cuts
  on a transaction-level abort and only spares a write the CALLER caught. Do not merge the two
  in memory.
- **`tx.signal` means "the transaction was interrupted", never "the callback stops"** (user,
  2026-09-10). Work the callback did not await outlives a successful transaction by design —
  the closed handle is what keeps it off the database. An abort after an explicit `commit()`
  still abandons the call: `transaction()` rejects, `tx.signal` fires, the commit stands.
- **Breaking, once:** a statement issued after the transaction's own `signal` fired reports
  `TRANSACTION_CLOSED` where rc.4 reported `signal.reason`. With D4 reversed, the write rule
  is not breaking — every behaviour it changes failed or committed an abandoned write.
- **One commit on the branch, `c2ef918`, landed with a failing `tsc` past the hook** and was
  fixed by `e45f566`; every other commit was proved green in clean worktrees. See
  `mem:lessons` before trusting a hook or a subagent's "pre-existing". How it got past — not
  a bypass; a commit created 25 s into a ~100 s hook — is traced in `mem:follow-ups` (the
  pre-commit hook entry), with the evidence in `.scratchpad/hook-forensics/`.

**What it does NOT deliver.** The savepoint variant. An eviction for any other reason — a
crashed worker — still loses a memory database, as it always has. Four review minors were
left by decision: the label of a poisoned rollback, the `settled`/`releasing` duplication, the
reused name `own`, and the `abandon` listener's lifetime on a caller-owned signal.

## The transaction's per-statement wait — merged 2026-09-10

No spec and no plan: brainstormed in chat, the user validating each step, like the write-lock
work below. Branch `fix/tx-statement-quiesce`. The invariant itself now lives in
`mem:architecture`; the numbers in `mem:measurements`, TX-QUIESCE.

**What it was.** A statement in a `transaction()` callback that ended before its result did
left the shared worker still finishing, and the next statement in the same callback met
`pool.ts`'s reuse guard. Four faces, one mechanism: `first()` on any query with a row left to
produce — its ordinary use — a `chunk()`/`stream()` `break`-ed out of BETWEEN two statements,
and `read`/`write`/`bulkWrite`/`output` cut short by a per-statement abort the callback caught.
Pre-existing, deterministic, both engines.

**Five things the code will not tell you:**

- **The scope was wrong in the backlog and reading the code is what fixed it.** The entry
  described a `tx.first()` defect for a week. `read`/`write` are immune on the normal path
  because they loop to `next.done` — that had to be READ, not inferred, and the entry said so.
- **Option B was designed and refused.** Making `pool.ts`'s reuse guard wait when
  `deferredChunk && stopped` would have covered the same four faces in one place, and cannot be
  forgotten by a seventh method. It loses on three counts: the discriminator holds only by an
  execution order established three layers away; the wait would be attributed to the innocent
  next statement rather than the culprit; and it sits before `runQuery` destructures its
  options, so the caller's own `signal` could not cut it. **Do not re-propose it without
  answering those three.**
- **The first version of the fix deadlocked, and only a boundary test found it.** Waiting
  unconditionally parks a statement the guard REFUSED behind a query it never claimed — which,
  for a generator the callback dropped, only `closeOpenStatements()` will ever close. Hence
  `owesWait` — replaced on 2026-09-12 by `mark.posted`, which states the same rule as "only a
  statement that was posted owes the wait" (`mem:architecture`).
- **A generator the callback merely DROPS is not covered and cannot be.** Nothing signals a
  drop; from outside it is indistinguishable from a consumer who means to come back to it. It
  still raises `GENERATOR_ABANDONED`, and that is now the only remaining trigger inside a
  transaction along with a deliberate overlap — which keeps the error reachable and its message
  true. The failure is clean and pinned: no eviction, rollback intact, client still serving.
- **Two comments in the repository were false and the measurement is what caught them.**
  `closeOpenStatements()` and `API.md` both said a transaction carrying no `signal`/`timeout`
  passes `abortable: false`. A transaction statement is ALWAYS abortable. What decides whether
  a running `step()` can be cut is the BUILD: the `sync` build without cross-origin isolation
  installs no progress handler at all. Both were corrected with the numbers.

**What it does NOT deliver.** The dropped generator above. And on the `sync` build without
isolation, a statement ending early waits for the current `step()` to finish — 360 ms on a
deliberately pathological query, `drainTimeout` at worst, with the write lock held. `API.md`
says exactly that, and no longer says anything about `signal`.

## The origin write lock — merged 2026-09-09

No spec and no plan: the design was settled in chat, in four steps the user validated one at a
time. Found by going looking for HANDLE-2 and finding something else.

**What it was.** A `transaction()` holds `bsq:write` for the whole of its callback — documented,
and the price of serializing writers across the origin. A callback that never returns held it
**for ever**: its lease is never released, so nothing released the lock, and every write in every
tab blocked with no error. `close()`, the only escape, terminated the workers, resolved, and left
the lock held. Deterministic, both engines, both VFS families. `mem:measurements`,
WRITELOCK-STUCK.

**Four things the code will not tell you:**

- **`PoolWorker.terminate()` is no longer the browser's method.** It poisons the transport
  first — see `mem:architecture`, which also carries the test-seam consequence. This is what
  turned "a statement after `close()` hangs for ever" into a rejection, and it is what let the
  transaction's fallback `ROLLBACK` fail instead of parking: that statement carries no signal by
  design, so nothing else could have reached it.
- **The asymmetry at `close()` is deliberate and the rule is durability, not transactions.**
  An ordinary write in flight is DRAINED, because each is its own commit and rejecting it would
  report failure for a row that landed — and on the `sync` build without isolation an abort
  stops the wait, not the work, so that lie would be routine. Nothing inside a transaction is
  durable before its `COMMIT`, so abandoning one misreports nothing. Stated in `API.md` under
  *Inside a transaction*.
- **Bounding the HOLDER was proposed and refused, and this is the only place that reasoning
  now lives.** A watchdog that abandons a transaction whose callback has gone quiet cannot
  work: a callback awaiting a slow but legitimate producer — an `output()` fed one row per
  `fetch` — and a callback stuck for ever are the same state seen from outside, and a single
  long statement is the mirror case. Any such bound kills sound work or misses dead work. The
  wait therefore stays unbounded by default and `timeout` on the waiting write remains the
  consumer's own choice. **Do not re-propose a default `transaction()` timeout: it caps exactly
  the long legitimate callback this refusal protects.**
- **A transaction left unawaited now surfaces an unhandled rejection** where it used to produce
  silence — it is in `CHANGELOG.md` under Breaking, and this repository's own suite had to be
  fixed for it. That is also how it was caught: `status` and `failedFiles` went red while every
  test passed, exactly as the baseline table warns.

**What it does NOT deliver.** Nothing bounds a stuck callback in a tab that stays open and never
closes. The victim's own `timeout` bounds the wait, closing the tab releases everything
(measured), and the timeout message now names whether this tab or another holds the lock — but
the holder is not policed, by decision.

## The abandoned generator — merged 2026-09-09, `ddd8270`

Design and its amendments A1-A5: `docs/superpowers/specs/2026-09-08-abandoned-generator-design.md`.
Plan: `docs/superpowers/plans/2026-09-08-abandoned-generator.md`. 25 commits, seven tasks, each
reviewed; two whole-branch reviews, three fix rounds. **Read the spec's amendments before the
spec** — two of its decisions were disproved by implementation.

**Four things the code will not tell you:**

- **The deterministic half is the one that matters.** The `FinalizationRegistry` is best effort
  and the documentation says so in those words; what makes the repair testable and bounded is
  that a `signal` or a `timeout` now runs the same teardown **at the abort**, not at the
  consumer's next pull. Every regression test is built on that half. D1 and D7.
- **`interrupt()` takes the transport it is stopping, and the argument is required.** Without it
  a late cleanup stops whatever the worker is running now — which silently truncated an
  unrelated query, 100 rows of 4000, bisected against `main`. Any new call site must name its
  transport; the type no longer lets it not.
- **A transaction closes the generators its callback left open**, interrupting the transport
  before returning them, because a method call on an async generator queues behind an in-flight
  `next()`. Getting that order wrong held the origin's write lock indefinitely.
- **`GENERATOR_ABANDONED`'s guard is structural.** It fires on "a query is already in flight on
  this worker", and its message leads with that rather than with a diagnosis — the premise that
  an abandoned generator is its only producer was checked and is false.

**What it does NOT deliver.** A generator abandoned while a `next()` is in flight is unreachable
by the registry until that `next()` settles — transient, and complementary to the leak, since a
worker with a request in flight is busy rather than stranded. And on the transaction path, a
generator abandoned with a `next()` outstanding and no `signal`/`timeout` costs up to
`drainTimeout` with the write lock held, then evicts the worker; that is written in `API.md`.

## Lot 10 — one `timeout`, eight methods — merged 2026-09-07

Design: `docs/superpowers/specs/2026-09-07-uniform-timeout-design.md`. Plan:
`docs/superpowers/plans/2026-09-07-uniform-timeout.md`. Eleven commits, five implementation
tasks, each reviewed; whole-branch review clean.

**It reverses D4 of the interruption design.** `timeout` was a budget of SQLite EXECUTION
time enforced inside the worker; it is now a **wall-clock deadline counted from the call**,
and it applies to eight methods rather than five. The generalization is what exposed the
problem: an execution budget does not extend to `transaction()`, `bulkWrite()` and
`output()` — none is one statement — and on the five it already had, a consumer writing
`timeout: 5000` had bounded nothing they could predict, since the clock only ran while
SQLite had the floor. Neither `timeout` nor `QUERY_TIMEOUT` had ever been released, so the
reversal cost no consumer anything.

**Four things the code will not tell you:**

- **The mechanism is that the abort REASON is the error.** `withDeadline` in `src/utils.ts`
  owns an `AbortController` and a `setTimeout` that aborts with the `SQLiteError` itself;
  `mergeSignals` relays a reason verbatim and every abort path already rejects with
  `signal.reason`, so there is no translation layer and nothing asks which signal fired.
  `AbortSignal.timeout()` is not used because it cannot carry a reason.
- **An external `signal` still rejects with `signal.reason`, verbatim — there is no
  `OPERATION_ABORT`, deliberately.** The rule is who owns the signal: a caller who supplies
  one already owns the rejection value, and the platform guarantees it comes back untouched.
  When the library creates the signal there is no caller reason to preserve. The asymmetry
  is that rule applied twice, not an inconsistency.
- **`timeout` and `signal` now share one limitation, by the user's decision (D6).** On the
  `sync` build without cross-origin isolation, `timeout` used to stop a running statement —
  a budget needs no channel, the worker reads its own clock — and now stops only the wait.
  That capability was removed knowingly; it was never released. It bought one table in
  `API.md` covering both options instead of a table plus an exception.
- **`errorCode` on the worker→client protocol lost its only producer** when
  `WorkerQueryTimeout` went. It is KEPT, with a comment saying so: the worker's check is
  structural, so it is the generic path by which a worker-minted code crosses the boundary,
  and it is the twin of the load-bearing `sqliteCode` branch beside it.

**One thing that happened and did not reproduce:** a `pnpm test` run hung on the Firefox
config for about two hours during task 2, then never recurred in any later run of the
branch. No report was emitted at all, which is itself the discriminator — an rstest timeout
produces a failure report, so a two-hour silence points at browser launch or the harness,
not at a test. Unresolved, and third in the queue above. The plan agreed on 2026-09-07:
`pnpm test:firefox` in a loop, wall-clock recorded per run, unattended — the normal band is
50-70 s, so 13 runs is about a quarter of an hour, and 13 is this repository's own bar, the
number that closed the `barrier` flake. All inside the band means a non-reproducing event and
this paragraph is the record. A recurrence gets captured with `DEBUG=pw:browser` to tell a
launch hang from a mid-suite one.

## Lot 9 — query interruption, merged 2026-09-05

`INTERRUPT-1` is closed. `timeout` is a per-query budget of SQLite EXECUTION time, on every
build with no isolation; `signal` now stops the statement itself, not only the wait. Design
and its decisions: `docs/superpowers/specs/2026-09-04-query-interruption-design.md` §5.
Numbers: `mem:measurements`. Merge `a06c349`, 20 commits.

**Three things about it that the code cannot tell you:**

- **The capability is detected as `cross-origin-isolated`, never as COOP/COEP.** Any header
  that grants isolation works, including `Document-Isolation-Policy`, which is Chromium-only
  and which a consumer may adopt without this library ever learning its name. Do not
  "clarify" the probe by naming a mechanism.
- **`SharedArrayBuffer` and `Atomics` must stay OUT of the API list `LIB_FLOOR` reads in
  `scripts/render-vfs-matrix.ts`.** They are used only behind that probe. Listing them raises
  the published floor for an optional capability — the `structuredClone` trap, which would
  have cost Chrome 92 → 98 for an error *cause*.
- **A fourth rstest project now exists and it is deliberately the only isolated one.** The
  ordinary projects stay un-isolated because that is what consumers deploy, and one test
  asserts the degraded `sync` behaviour there. `server.headers` in an rstest config is
  silently ignored; the isolation comes from a `modifyRsbuildConfig` plugin, beside the one
  that already existed for the same reason.

**What it does NOT deliver:** on the `sync` build without isolation — `OPFSWriteAheadVFS`,
`OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS` by default — a `signal` still stops
the wait and not the work. Those four accept `build: 'async'`, which is the escape hatch
that costs no hosting change. The README says all of this in one table.

## The documentation — three pages, reworked in full on 2026-09-08

`README.md`, `API.md` and `VFS.md`, on `main`. The split happened 2026-09-07; the whole
rework of the three pages happened 2026-09-08, in two commits plus a merge. **Six things the
files do not say about themselves:**

- **The recommendation is documentation and no longer lives in `src/`.** `RECOMMENDED_VFS`
  was an unexported constant in `src/types.ts`; it is now a two-element list in
  `scripts/render-vfs-matrix.ts`. Three `INVALID_OPTION` messages used to ship a VFS name to
  consumers in a string — they now point at `VFS.md` and the bench page and name none. A test
  pins that: the message must contain no key of `VFS_CAPABILITIES`.
- **The generator writes BOTH pages.** `scripts/render-vfs-matrix.ts` owns fourteen spans in
  `VFS.md` and one in `API.md` — the shared-store list in `deleteDatabase`'s warning. Its
  name says `vfs-matrix`; it has not been only that since 2026-09-08.
- **`VFS.md` has FOURTEEN generated zones, not two.** Counted 2026-09-08 with
  `grep -c 'BEGIN GENERATED' VFS.md`, which is how to re-check it; this file said eleven
  until then. The VFS table, the build table, one
  BEGIN/END pair per VFS for its header block, the footnotes, the shared-store list inside a
  blockquote, and the contents list. `pnpm docs:vfs` fails loudly if a marker pair is missing.
  The contents list is built from the headings present, so renaming a section moves its entry.
- **Two footnote systems, deliberately.** GFM footnotes were dropped for plain HTML
  (`<sup><a href="#fn-N">[N]</a></sup>` + `<sub>`) because GFM renders a note shared nine
  times as `1`, `1:2`, `1:3`. Identical note texts are folded on their TEXT, so the two Memory
  VFS share one. The muted grey of GFM's footnote block **cannot** be reproduced — GitHub
  strips `style` and custom `class` — and the generator says so; do not go looking again.
- **`VFS.md` entries carry no comparison between VFS (user, 2026-09-08).** An entry describes
  its VFS, its characteristics and its limits. Ranking belongs to *Recommendations* and to
  the *If you can guarantee a browser* table, and duplicating it per entry could only diverge.
  The word "upstream" is banned; say "wa-sqlite".
- **No measurements in the three pages (user, 2026-09-08).** Repeatedly enforced: the
  `poolSize` startup numbers, the statement-cache percentages, the `build: 'async'` factor,
  "102 of 104 browser tests on Firefox" — all removed. Constants of the code are not
  measurements and stay: `DELETE_TIMEOUT = 30_000`, the 32-statement cache, `SQLITE_MAX_VARS`.
- **Method sections share one shape:** presentation sentence, example, options table, prose.
  The table says what an option IS; effects go below it. `createSQLiteClient` is the one
  exception, with a sentence before its table explaining why `vfs` has no default.

**Cross-references were verified on 2026-09-08**: 205 links across the three files, markdown
and HTML, all resolving. Nothing keeps them that way — there is no link checker in CI.

## `poolSize` defaulted to a number the caller never chose — fixed 2026-09-08

`feat/pool-size-default`, one commit plus merge `add17b9`, outside the rc.5 lots. `poolSize`
resolved to `DEFAULT_POOL_SIZE` (2) unconditionally while the guard below rejected anything
above the VFS's cap, so `createSQLiteClient(name, { vfs: 'MemoryVFS' })` — with no other
option — threw `INVALID_OPTION` at construction, on the four single-connection VFS. A test
pinned that behaviour and its own comment called it a footgun.

The default is now `Math.min(DEFAULT_POOL_SIZE, capability.maxPoolSize ?? DEFAULT_POOL_SIZE)`.
**Only the default moved**: an explicit oversize still throws, and still names the size to
set. Resolution of `vfs`/`capability` had to move above the pool block, since `abortSlots`
sizes its `SharedArrayBuffer` from `poolSize`.

**The two lots of 2026-09-08 were not separable at hunk level**, and that is worth knowing
before attempting the same split again: the doc lot removed `RECOMMENDED_VFS` from
`src/types.ts`, which the pre-fix `src/client.ts` still imports, so a fix-only commit did not
typecheck until `types.ts` was also at HEAD. The way through was backing the five files up,
resetting to HEAD, re-applying the four fix edits, committing, restoring. Nothing was stashed.

## The dropped chunk — fixed on `main` 2026-09-04, outside the rc.5 lots

Found by the query-interruption lot's first task and fixed on its own branch from `main`,
deliberately: a released data-loss defect should not ride inside a feature branch, and the
user stopped the lot to take it first. `fix/dropped-chunk`, two commits, merge `e83d9b5`,
reviewed on the whole branch before merging. What it was and what it measured:
`mem:measurements`; what it teaches about testing a streaming API: `mem:lessons`.

## rc.5 so far: nine lots, merged 2026-09-02 to 2026-09-05

Five branches, each merged into `main` with `--no-ff` and verified on the merged result; all are
deleted and no stale ref remains. Lots 1-3 rode one branch — the user judged them three faces of one
feature and accepted a larger whole-branch review for it; lot 4 had its own, lots 5 and 6 shared
one, and lot 7 had its own. Each was verified
against the baseline table above, which is the only place that table lives.

**Not pushed.** `main` sits ahead of `origin/main`, which is normal here.

**Read the specs, not a summary** — lots 1-4 and 7 have one each in `docs/superpowers/specs/`, dated
2026-08-31, 2026-09-02 and 2026-09-03, and four carry amendments made during implementation. **Lots 5 and 6 have no
spec**: bounded, brainstormed in chat, and their whole case is the measurement campaigns in
`mem:measurements`. Lot 7 also has a plan in `docs/superpowers/plans/` — the only lot that does.

1. **Cross-tab coordination.** Writes serialize across every client and tab; read-your-own-writes
   holds across tabs on every VFS but `IDBMirrorVFS`. Mechanism and invariants: `mem:architecture`.
2. **The connection lifetime lock.** Every client holds `bsq:conn:<ns>:<file>` for its life —
   shared normally, exclusive where `exclusiveConnection` is declared, absent on the memory VFS.
3. **`deleteDatabase` reports.** `DATABASE_IN_USE` when a client holds it, `DATABASE_NOT_FOUND` when
   nothing is there. Two new public error codes.
4. **The statement cache is bounded in bytes**, 8 MB per worker, alongside the 32-entry bound it
   keeps. Internal only — no option changed. **It buys a ceiling, not a saving**, and the CHANGELOG
   says so in those words: one `bulkWrite` retained ~3 MB before and retains ~3 MB after. What was
   unbounded is an application accumulating many large templates.
5. **Per-VFS default PRAGMAs**, declared in `VFS_CAPABILITIES.defaultPragmas` and generated into
   the README's VFS table. Exactly one VFS clears the bar — `AccessHandlePoolVFS` gets
   `locking_mode=exclusive` + `journal_mode=wal`, ~4.7x on write-transaction overhead, measured.
   **Consumer pragmas are MERGED over the defaults, not substituted**, so setting `foreign_keys`
   no longer costs a default nobody knew was there; naming a key is how one is refused.
6. **COOPSYNC-BUSY fixed.** A read reported busy by SQLite is retried once, closing a defect
   where `OPFSCoopSyncVFS` surfaced a step of its own handle-transfer protocol as a failure —
   one ordinary read per session, early, **on both engines at the default `poolSize`**. The
   discriminator is `sqliteCode`, not a VFS name, so a `BUSY` this library raises to mean
   "stop" still fails fast. `stream()` and `chunk()` retry only before a row has been delivered.
7. **Database inspection.** `inspectDatabase(file, { vfs })` and `db.inspect()` report who is
   live on a database across the origin — clients, tabs, and the write lock's holder with the
   count of writers queued behind it — **without opening it**, which is the point: the question
   arrives from code holding no client. Read on demand, never maintained; each client holds an
   uncontended liveness marker `bsq:client:<ns>:<file>:<uuid>:<vfs>:<label>`. Plus five readonly
   getters on the client (`id`, `name`, `file`, `vfs`, `build`) and `UNSUPPORTED`, a new public
   error code. `db.debug.name` changed value — breaking.

8. **The benchmark page measures the VFS, and says what it could not establish.** Its dataset
   fitted seven times inside SQLite's page cache, so several read rows were timing the cache
   rather than storage; at 100 000 rows they reach the VFS, and every `—` cell went away
   (the cause was the clock, not the dataset — reads are now timed in groups). The pre-run
   sweep is bounded per operation and reports what it could not remove, in the page and in
   the export, which added `sweep`, `opfsRootAtStart` and `preview`. Two rows are new: an
   overwrite workload, the one shape every other write row here was missing, and
   `reads-during-long-query`, a verdict rather than a ratio — **it is the first per-VFS
   evidence for HANDLE-1**, and it immediately falsified three README claims
   (`CHANGELOG.md`, Documentation). Numbers and the four-platform campaign:
   `mem:measurements`. **No `src/` change.**

**Three consumer-visible behaviour changes, all from lots 1-3 and all in `CHANGELOG.md` under
Breaking:** two clients
writing at once no longer produce `BUSY` (the second waits); a refused deletion reports
`DATABASE_IN_USE` where it reported `WORKER_CRASHED` or nothing; and **deletion is no longer
idempotent**. **A fourth arrived with lot 7:** `db.debug.name` now carries the client name with
its index (`"SQLite 1"`) where it carried the bare `name` option — a value identical for every
client that passed nothing, so it identified nothing even inside one tab, and it had no reader
anywhere in the repository.

**What it does NOT deliver, and the README says so:** reads still wait on the rotated exclusive OPFS
handle wherever `readwrite-unsafe` is missing. `IDBMirrorVFS` gains nothing cross-tab.
`OPFSCoopSyncVFS`'s stalls are untouched. And deleting through the wrong VFS is still destructive
within the `opfs-path` family — that family shares one file, which is measured and now carries a
README warning.

## Pending, and not ours to move

- **The upstream PR is MERGED (user, 2026-08-28): `rhashimoto/wa-sqlite#344`**,
  "Fix OPFSAnyContextVFS writes on WebKit by copying the page buffer", from
  `lalexdotcom`. rhashimoto's two conditions — a link to a filed WebKit bug, and
  the original `.subarray()` kept commented out above a TODO — were satisfied
  before he merged. **Nothing is owed upstream.**
  - **Nothing waits for a wa-sqlite release any more (user, 2026-09-15).** wa-sqlite is pinned by
    commit SHA to upstream `93b9230` since 2026-09-21 (`07ad48c` before), which carries #344, and the AnyContext patch is gone
    (`mem:stack-and-build`). Upstream's `v1.1.2` tag predates that merge; no release carrying it
    existed on 2026-09-15.
  - **The WebKit bug already existed — do not file another one.**
    <https://bugs.webkit.org/show_bug.cgi?id=302733>, "FileSystemWritableFileStream.write()
    ignores byteOffset when writing TypedArray subarrays", Website Storage,
    still `NEW`, filed 2025-11-18, radar `rdar://problem/165411850`. It is our
    exact case and the report itself names `.slice()` as the workaround, so the
    patch is the sanctioned fix, not a guess. A second reporter extended it to
    `DataView` on 2026-08-24. No WebKit PR touches it.
  - **Open upstream: rhashimoto/wa-sqlite#347** (2026-09-15), the `OPFSCoopSyncVFS` hand-over fix,
    from `lalexdotcom:fix/coopsync-deferred-handle-release`: the two changes of
    `patches/wa-sqlite@1.1.2.patch` plus `test/vfs_handover.js`, which fails on its master (47 and 46
    `BUSY` in 100 steps, 9 `NotFoundError` in 10 starts) and passes with them; upstream CI run #392
    green. The PR text is the user's. When it merges, repin to the merge commit and delete the patch —
    regenerated or removed through `pnpm patch` / `pnpm patch-commit`, never by hand.
  - **Tooling, since `gh` is still not installed here:** PR bodies, comments and
    Bugzilla all read fine through `WebFetch` on `api.github.com` and
    `bugs.webkit.org`; the fork clone lives at `.work/wa-sqlite` and pushes
    through the VS Code credential helper. Creating a fork or posting a comment
    still needs the user — no token in this container. **Reading Actions logs
    needs admin rights and is refused too**, so a failing run is diagnosed from
    its check-run annotations, or by the user pasting the step.

## The release path, now that it has run for real

Procedure and invariants are in `mem:conventions`; this is only what rc.4's two
failures established that no reading would have.

- **The ordering is load-bearing and was proved twice.** rc.4 failed once before
  anything existed and once with the GitHub Release created but `npm publish`
  refused; neither burnt the version number. Under the old order — publish first —
  the second failure would have cost `1.0.0-rc.4` permanently.
- **The action is not idempotent, and nothing fixes that yet.** Once the release
  exists, re-running the job fails at `gh release create` before reaching npm.
  Recovery is: delete the release and the tag, then retag. A
  `gh release view … || gh release create …` in
  `lalexdotcom/action-release-and-publish` would make a partial failure replayable;
  it is not written.
- **`NPM_TOKEN` is a long-lived secret that expired unnoticed** and is what failed
  the second attempt. **Trusted publishing was examined and closed by the user on
  2026-09-03, without being adopted**: npm's OIDC covers `npm publish` only, and
  `npm dist-tag add` — which the action runs twice, for `latest` and `next` — still
  needs a token ([npm/cli#8547](https://github.com/npm/cli/issues/8547), open).
  A token would survive the change, so the change was not worth its cost. **Do not
  re-propose it while the `rc`/`next`/`latest` triplet stands**; the only thing that
  would reopen the question is npm supporting dist-tags over OIDC. The remaining
  guard against a silent expiry is watching the token's expiry date by hand —
  **and it was renewed for 90 days at rc.4's release, so it runs out around
  2026-11-29** (user, 2026-09-05; the date is derived from that renewal, not read
  off npm). rc.5 is comfortably inside it. A release planned after that window
  checks the token FIRST: this is the failure that cost rc.4 its second attempt,
  and it announces itself only at `npm publish`, after the GitHub Release exists.

## Unmeasured ground — what a claim here would be inventing

- **`OPFSWriteAheadVFS` on Safari is measured now** and gives no concurrency there, so it
  earns a Safari user nothing. What is *not* measured is any engine beyond Chromium,
  Firefox and the four Apple devices of 2026-08-27.
- **`deleteDatabase` is measured on six devices and times out on two VFS off
  Chromium.** n=1 per device; written into Known Limitations on 2026-08-27 as an
  observation, in those words.
- **Nothing in this repo reproduces a pool that never frees a worker.** Chromium
  always does, so the suite stayed green through three real abort defects. The
  benchmark page is the reproducer and a device campaign is the verification —
  `mem:lessons` records what that cost.
- **`survives-reopen` was believed to flip between runs, and no longer is.** REOPEN-1 was
  closed on 2026-09-03: five Safari 27 runs on the two devices that produced the original
  timeouts all pass, on rc.5 — `mem:measurements` carries the campaign. n≥3 per device before
  citing a flip remains the rule. `no-read-inside-transaction` does
  **not** flip at n=3 per engine in this container — measured 2026-08-31, table in
  `mem:measurements`, which is also where the unreachable WebKit flip is recorded.
- **The bench page's floor is no longer unmeasured ground.** Its export carries
  `opfsRootAtStart`, `sweep` and `preview` since 2026-09-03, so a run says what it started
  from, what the sweep could not establish, and whether it is the released build. Numbers and
  what they immediately caught: `mem:measurements`.

## Known live exposures

- **`1.0.0-rc.4` is published under `latest` with a silent data-loss defect, and that is a
  decision, not an oversight (user, 2026-09-04).** `stream()` and `chunk()` drop rows for
  any consumer that awaits between chunks — 501 of 1001 at the default settings, measured
  on the tag itself (`mem:measurements`). The fix is on `main` and **rides in rc.5, which
  the user judged near enough not to hurry**: no emergency release, no note added to the
  rc.4 GitHub release. Do not re-propose either without new information; what would be new
  is a consumer reporting it, or rc.5 slipping far enough that "not far" stops being true.

- **The Pages site is a pure function of TWO TAGS, and this file said otherwise until
  2026-09-03.** `/` is built from the latest release tag, `/preview/` from the `preview` tag,
  and the ref that TRIGGERED a run is never built. So `/` cannot drift to unreleased code and
  a preview cannot survive as a mystery. The old wording here — "last deploy wins, a manual
  dispatch from any `feat/*` branch replaces it" — is wrong on both halves: there is no manual
  dispatch, and a preview does not replace the release page. Read the header of
  `.github/workflows/pages.yaml`, which is authoritative.
  - **Moving the tag is the whole gesture**: `git tag -f preview <sha> && git push -f origin
    preview`. Deleting the tag takes the preview down. Both need `main` allowed in the
    `github-pages` environment, because a `delete` run executes from the default branch.
  - **Re-pushing the tag UNCHANGED does nothing** — git answers `Everything up-to-date` and
    emits no event, so no run starts. This file and the workflow both claimed otherwise
    until 2026-09-04. To republish without moving it: `git push origin --delete preview &&
    git push origin preview`, which briefly takes the preview down.
  - **A run that publishes nothing could cancel one that does, and did.** `pages.yaml` has
    `cancel-in-progress` on a shared group, `concurrency` is evaluated before any job runs,
    and `delete` carries no ref filter — so deleting a merged branch on 2026-09-04 killed the
    preview deploy pushed two seconds earlier, then skipped itself, leaving the site on the
    previous build with nothing to say so. Fixed by repeating the job's guard in the group
    expression, so a skipping run gets `pages-noop-<run_id>` and contends with nobody. **The
    two conditions must stay identical; `concurrency` cannot read `env`.** The expression was
    verified valid on GitHub (a bad one fails the run at startup, and a scratch branch
    deletion came back `skipped`); the cancellation itself was never staged.
  - Exposure kept deliberately (2026-08-26, user): putting a branch on a real device without
    merging is worth it — which is what makes the page's "development build" banner
    load-bearing. `buildRef()` in `scripts/bench/assemble.mjs` is not decoration. The preview
    half is assembled with `--ref "preview @ <sha>"` and no `--release`, so its exports carry
    that label in `preview`.
- **The pinned Vite 6 consumer fixture is the only thing verifying the README's one
  instruction.** `tests/consumer` resolves to the newest Vite, where `optimizeDeps.exclude`
  is a no-op. Delete `tests/consumer-vite6` and that line goes back to unverified prose.
- **The Parcel fixture is what keeps `main` in `package.json` alive.** Parcel is the only
  resolver in the smoke that ignores `exports`; without the fixture the field reads as dead
  weight and will be deleted.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped,
`mem:measurements` for every number this project owns.
