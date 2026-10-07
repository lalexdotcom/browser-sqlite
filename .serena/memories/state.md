# State — where the work stands

**Updated 2026-10-07.** Rewrite this whole file when it stops being true; do not append a
new dated section under the old one.

**No SHAs, no commit counts, no branch names here (user, 2026-08-27).** `git log`,
`git status` and `git branch` answer all of that in one command and always correctly, while
a copy here rots — it did three times in a single day, on the same file, naming a stale
HEAD, a stale count and a conformance result that a fix had already changed. `mem:index`
already says it: these memories carry what cannot be re-derived. This file is decisions,
obligations and unmeasured ground.

## Standing facts about the repository

- **`1.0.0-rc.7` is published**, on 2026-10-06 (rc.6 the same morning): on npm under `rc`, `next` and `latest`
  (verified on the registry after the run), with provenance, and as a GitHub prerelease whose body is the CHANGELOG section for the tag.
  `package.json` sits at `1.0.0-rc.7` until the user calls the next bump. Its section is
  what landed after rc.6 — the object/Date/JSONB conversion of `bulkWrite()`/`output()` and the docs shipped in the package.
  **`## [Unreleased]` was reopened empty in the bump commit**, as the `changelog-maintenance` skill does at every release (`mem:conventions`).
  The release gate ran green first time: `verify`, `consumer-smoke`, 22/22 cells, then `release`.
- **The vendored wa-sqlite sits on upstream `master` of 2026-10-05** (`96d91182`, `package.json` has the
  SHA), which merged #375, the last PR carried in `dist/`. **`patches/wa-sqlite@1.1.2.patch` carries `IDBMirrorVFS.js` for #371 and #372** (both open upstream, conflicting in `jClose`), **and a one-line guard in `OPFSAdaptiveVFS.js` for #374** (open upstream); heads and the merge in `mem:stack-and-build`. The installed `src/` was checked equal to the pin plus the patch (build sources aside), `dist/` to the pin's. The repin changed executed code in the `async` build — its glue and `.wasm`, which the patch had not carried from #375 — and the matrix's one red cell was traced to a test race, not to it (`mem:history`, 2026-10-05).
- **The release gate ran the full matrix for the first time, and it took four tags to get
  through.** 22/22 cells, `verify`, `consumer-smoke`, then `release`, with `untag` skipped.
  The three refusals before it were not test failures: `test-matrix.mjs` could not read a
  report that only exists for an agent (`mem:lessons`, 2026-09-22). Every cell it called
  "timed out" had passed every test.
- **Pushing is still not part of committing** (`mem:conventions`), and `main` may sit ahead
  of `origin/main` indefinitely. It was pushed on 2026-08-31 because a release needs the
  remote to carry the tagged commits, not because the convention changed. Do not push as
  housekeeping.
- **Feature branches are merged with `--no-ff`** and a body explaining the change, matching
  every previous merge.

## The verification baseline — compare against these, re-measured 2026-10-06

Not history: the numbers a regression is detected against. **Every figure below was read off ONE run in this container on 2026-10-06, late morning, on the branch that made `bulkWrite()`/`output()` convert objects** (merged into `main` the same day) — none is arithmetic, on the wa-sqlite pin `96d91182` with #371, #372 and #374 carried.

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm build` | clean |
| `pnpm test` | **THREE reports**, `status: pass` and `failedFiles: 0` on each: **1449 tests, 1441 passed, 8 skipped** (unit + the two chromium target projects), **832 tests, 828 passed, 4 skipped** (the two firefox target projects), **18 tests, none skipped** (the two isolated target projects). The chromium and firefox targets are `OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi` since the default build follows the engine |
| `pnpm exec rstest --project unit run` | **619** tests, 30 files |
| `pnpm exec rstest --project 'chromium*' run` | the two chromium target projects; the glob is required since 2026-09-15 — project names are `chromium · <vfs>/<build>` and rstest's filter is anchored |
| `pnpm test:conformance` | **TWO reports** — 97 tests / 3 files each: **Chromium 83 passed / 14 skipped, Firefox 79 / 18** — they differ by design since 2026-09-14. Each VFS runs on its default build for the engine, so the `jspi`-first VFS run `jspi` here |
| `pnpm exec biome ci .` | exit 0 |
| `pnpm docs:vfs` | leaves `VFS.md` unchanged (`git diff --exit-code`) |
| `pnpm test:consumer` | 24/24 stages |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chromium --all` | `OK`, `"reasons": {}`; the checker requires `poolSize` and `longQueryCalibration` among the keys. `bench:build`, not `build`: the checker serves `_site/`. Pass `BENCH_PORT` to leave 8099 to `bench:serve` |
| `pnpm lint` | 169 files, **4 warnings**, 1 info — the file count moves with the tree, **the warning count is the signal** |
| `dependencies` in `package.json` | absent |
| `pnpm test:matrix` | **66 of 66 cells green, 2410 s**, no re-run inside it. ~40 min. **Every cell runs `BSQ_TEST_NEEDS=skip`**, so its skips are the tests whose need the pair lacks: chromium from 4 (`OPFSAdaptiveVFS`, `OPFSAnyContextVFS`) to 81 (`MemoryVFS/sync`), firefox from 2 (`OPFSAnyContextVFS`) to 79 (`MemoryVFS/sync`), isolated 9/0/0 everywhere. No Firefox page crash in this run. On the 42 cells compared one by one with the 2026-10-05 run, 6 % slower in total, no cell more than a few seconds. |

Against the previous table (2026-10-05): unit 599 → 619 (one file added, `values.test.ts`), `pnpm test` +30 / +10 tests and passed with no skip added (the value conversion of `bulkWrite()`/`output()`), the isolated config, conformance, lint warnings, the consumer smoke and the matrix's skip ranges unchanged; the matrix is 66 of 66 again.

**Do not reconcile any of these by arithmetic; re-run.** A previous version of this table was
measured on 2026-09-15 and went stale the next day, and another contradicted itself in September
2026 — its prose said 1181 / 676 / 14 while its own row still said 1175 / 670, because a cell had
been patched and the table had not been re-read. **Re-measure the whole table when you touch it.**

**`pnpm test` chains THREE configs** — chromium+unit, firefox, and the isolated project — so a
green `pnpm test` covers what CI covers. Since 2026-09-11 a commit pays only the unit project; a merge or a push pays all three
(`mem:git-hooks`).
**A green `pnpm test` is not a green tree: run `pnpm exec tsc --noEmit` beside it** — a commit
on the last branch landed with a failing typecheck that no test run could show (`mem:lessons`).


**The browser skips are expected: 4 per Chromium project, 2 per Firefox project since 2026-09-28** (1 before: `barrier.test.ts`'s "closes the pragma the barrier opens on OPFSWriteAheadVFS" skips without `readwrite-unsafe`). Each config
now builds ONE project per target, so the table's per-config totals are twice those: **8** on the
chromium report and **4** on the firefox one. Count per project before comparing. One, on both, is
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

  **No decision is owed any more.** The merge was given on 2026-09-18, and HANDLE-2 was closed by the
  user on 2026-09-21 as a misattribution (`mem:vfs`).

  The Firefox silent hang that blocked runs is diagnosed and guarded, not cured:
  `navigator.storage.getDirectory()` can fail to settle in a worker on Firefox.

**rc.5 does NOT ship with the open subjects below (user, 2026-09-09).** Said of two subjects,
and both are now closed — the second by merge `eeabe06` on 2026-09-11.

- **HANDLE-2 was investigated the same day and came apart** — its stated cause is measured
  false and the wedge does not reproduce anywhere, on `main` or before the fix (§ below).
  What produced its symptom was a write-lock defect, now fixed and merged.
- **The short-circuited-statement defect is FIXED and merged** (2026-09-10, `mem:history/waves`). What was
  described here as a `tx.first()` defect was four faces of one mechanism.
- **The per-statement `timeout` inside `transaction()` is fixed and merged** (2026-09-11,
  merge `eeabe06`, `mem:history/waves`). What it exposed — an interrupted write inside a transaction,
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

**A third gate is closed: the README was reworked on 2026-09-07** (`mem:history/waves`), which is what
the 2026-09-05 entry in `mem:follow-ups` called for.

**`feat/debug-request-history` merged into `main` on 2026-10-01 and deleted.** `db.debug` is public and documented as outside semver, with one pool-level `requests` history (`mem:history`, `mem:architecture`). Everything on the branch is green, the verification baseline above was re-measured on it, and the two `db.debug` entries of `mem:follow-ups` are closed. On 2026-10-01 the user added two changes to it (spec § 6): `affected` 0 for a statement that changes nothing, and internal statements flagged out of the sums. The matrix on that head was 64 of 66 — the two red cells were the `IDBBatchAtomicVFS` intermittent, fixed the same day: a journal deletion lost with its worker, so the next client rolled a committed transaction back (#370, `fix/idb-second-client`, `mem:history`); 66 of 66 since. The branch also carries another agent's upstream commits (#351, #363). Five commits written by subagents carry their own model in the trailer (`Claude Sonnet 5` on `c0398a4`, `4f2a84b`, `ac5de88`, `511cec6`, `Claude Haiku 4.5` on `8490d08`); they were merged as they are.

**Otherwise nothing is in flight (2026-09-28).** The `open-retry` Firefox timeout was worked on 2026-09-28 and not reproduced on demand; the test now fails naming the step it hangs in, and `mem:follow-ups` (`open-retry`) says what to do for each step at the next sighting. The same day added a `db.debug` entry (`currentRequest` never cleared) to `mem:follow-ups`. The `lifecycle.test.ts` page crash logged then was found and fixed on 2026-10-03 (`mem:history`); the Playwright issue it leaves is a follow-up. The test-fragility list the user brought on 2026-09-25 is worked through (`mem:history`, the four rows of 2026-09-25/27); what is left of it is parked in `mem:follow-ups` — the barrier's data staleness (BARRIER-DATA), left without a falsifier of ours by decision on 2026-10-03 (its Notes), and `handleDeath`'s untested guard; `pool-cap`'s surplus-slot flake was closed by the user on 2026-09-27 and kept in the Notes. The Firefox reuse-guard load campaign ran on 2026-09-27, 0 hits in ten whole-config passes (REUSE-LOAD), and the user closed that entry the same day — kept under `mem:follow-ups`' Notes with what to do if it is seen again. It surfaced `interrupt.test.ts`'s sync test timing out under load, a test budget, fixed the same day with a `drainTimeout`; chasing the engine difference behind it found the test helper that let an abort land on the freshness barrier, fixed too (`mem:history`, `mem:follow-ups`). rhashimoto/wa-sqlite#363 is open and carried in `patches/`. #365 was MERGED on 2026-09-29 (`5be9cd14`, identical to our head) as the opt-in `PRAGMA wal_read_latest`, which the library's barrier sets for its own read on `OPFSWriteAheadVFS`, and the pin is on it since the same day. #366 (the api/sql tests on the default build) was merged on 2026-09-30; the three leak PRs #367, #368, #369 are open, green, and the leak fixes carried in `patches/` (`mem:follow-ups`). The same day found that rstest's pages are off-the-record, which inflates every absolute OPFS timing taken there (RSTEST-OTR) — a measurement caveat in `mem:follow-ups`' Notes since 2026-10-03; no persistent-context harness is planned. Answering rhashimoto's follow-up on #365 found #350's class of leak in `OPFSWriteAheadVFS`, `AccessHandlePoolVFS` and `OPFSAdaptiveVFS` (reproduced) and `OPFSCoopSyncVFS` (read only; forced on 2026-09-30, it blocks nothing); reported on #365, PRs offered; measured on 2026-09-30, only `AccessHandlePoolVFS`'s reaches this library, and `tests/browser/vfs-create-retry.test.ts` guards it (LEAK-LIB, `mem:measurements`). The same day `failClient` was made to release the connection lock, which it used to leave to `close()` (user's decision, `mem:history`). The same day `AGENTS.md` took the git and changelog rules and `CHANGELOG.md` moved to Keep a Changelog (`mem:conventions`). **#351 was revised on 2026-09-30** after rhashimoto questioned a sentence of its description: the sentence was wrong, the case it meant is reached with `journal_mode=PERSIST`, and our first fix left overlapping blocks in a persistent journal; the branch got upstream master merged in, a second fix and two tests, the patch carries the new head, and it waits on his review (`mem:follow-ups`, `mem:measurements` 351-PERSIST, `docs/upstream/`). His second review (2026-09-30: two comments he wrote out, an open key range, a single-fetch idea left as a TODO) was answered and pushed on 2026-10-01, and the patch carries that head. **#363 was questioned on 2026-10-01**: rhashimoto doubted that SQLite truncates after its last `xSync`, then reproduced it with the CLI and asked the SQLite forum. Answered with SQLite 3.53.0's `pager.c` — the version wa-sqlite builds — and a probe showing that with `synchronous=OFF` master hides whole commits from another context; master merged into the branch, description remeasured, patch unchanged (`mem:follow-ups`, `mem:measurements` 363-SYNC-OFF, `docs/upstream/`). **On 2026-10-02 he requested changes** (`IDBMirrorVFS`'s `SQLITE_FCNTL_SYNC`/`COMMIT_PHASETWO` design instead of `jUnlock`); measured against the PR, it loses another context's commit after a write error, and the reply posted the same day proposes his design plus the `jUnlock` close and offers a separate PR for an `IDBMirrorVFS` commit-abort defect found on the way (`mem:follow-ups`, `mem:measurements` 363-ERROR-PATH and IDBMIRROR-COMMIT-ABORT). Upstream master is at `fa111290` since the same day — our #366 merged, tests and a README only — and the pin stays on `5be9cd14`. **#352 and #353 were reviewed by rhashimoto on 2026-09-29** — comments to shorten, and on #353 a rounding he called unnecessary; both were revised, pushed with upstream master merged in and answered on 2026-09-30, the user re-requested his review, and the patch carried the new heads (`mem:follow-ups`, `docs/upstream/`). **#352 and #353 merged on 2026-09-30, #351 on 2026-10-01**, all three byte-identical to our heads; the repin of 2026-10-01 to `7a4b4241` dropped them from the patch. **#370 opened on 2026-10-01** (the `IDBBatchAtomicVFS` journal deletion), carried in the patch. **#341 is settled for us (2026-09-29):** the deterministic trigger — `retry()` in `sqlite-api.js` sharing `Module.retryOps` across calls — needs two calls in flight in one module, which rhashimoto ruled outside the supported case, and which the library never does (`mem:architecture`); no PR, no patch, branches deleted (RETRY-OPS, `mem:measurements`). Another agent's work was paused by the user until our upstream PRs were done; the user relaunches it. `main` sits ahead of `origin/main` — the convention, not an oversight.

**The subject the user set on 2026-09-21 — the two `OPFSCoopSyncVFS` opens that failed on chromium — is CLOSED, and it was closed before it was started.** `mem:follow-ups` still described it as HANDLE-CORPSE on a path the retry misses; that entry had rotted. The cells failed at MATRIX-5 (2026-09-18 08:25) and the two fixes landed at 13:33 and 13:34 the same day: wa-sqlite #350 (the partial acquisition that leaks the handles beside the one that failed, which is what made every retry fail on `-journal`) and `exclusiveFileHandle` + `openWithRetry` on our side — `OPFSCoopSyncVFS` **is** declared `exclusiveFileHandle: true`, so `sqlite3_open_v2` does get the retry. Verified by measurement rather than by reading: eight consecutive runs of that cell, 8/8 green, plus the two full matrices since (COOPSYNC-OPEN-CLOSED, `mem:measurements`).

**What survives of it is diagnosability, and only that:** `jOpen`'s asynchronous phase never sets `this.lastError`, so an open blocked by a dead context is indistinguishable from a missing file. One line upstream, both consumers already in place, unscheduled — `mem:follow-ups`. Everything else there stays unscheduled; the default build it named shipped on 2026-09-24. Upstream, rhashimoto/wa-sqlite#347 was merged on 2026-09-26 (§ Pending).

**HANDLE-2 was investigated on 2026-09-09 and came apart under measurement.** Its stated cause
is false — Firefox releases a killed worker's sync access handle in 1-6 ms (HANDLE-ORPHAN) — and
the wedge itself does not reproduce: ~70 attempts on `main` in six shapes, and **0/40 at the
pre-fix commit on the very VFS where 9/40 was recorded**. Details and the failed reproductions:
`mem:vfs`, HANDLE-2; `mem:measurements`, "HANDLE-2 does not reproduce".

**CLOSED by the user on 2026-09-21: the entry was a misattribution.** What produced its symptom —
permanent, silent, origin-wide — was found and fixed the same day (`mem:history/waves`), and that defect
reproduces every time where HANDLE-2 reproduces never. The one candidate that survives the closure
is the single-shot `onmessage` listener in `OPFSCoopSyncVFS.jLock` (`mem:vfs`); nothing else about
the entry is owed.

**The `RECOMMENDED_VFS` question is settled and must not be reopened.** It was answered on
2026-09-08 by medianing the bench corpus at n≥3 per platform (`mem:measurements`,
VFS-MEDIAN). The answer was not "move it": there are now **two** recommendations,
`OPFSWriteAheadVFS` and `OPFSAdaptiveVFS`, and the constant itself left `src/` — see `mem:history/waves`.

## The merged waves

What each merged wave left that the code will not tell you is in `mem:history/waves`.

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
  - **rhashimoto/wa-sqlite#347 is MERGED (2026-09-26, `d685fef0`)**, the `OPFSCoopSyncVFS` hand-over fix
    with its test `test/vfs_handover.js`. The pin carries it and the patch holds nothing for that VFS.
    What is open upstream is in `mem:follow-ups` and `mem:stack-and-build`; a patch is regenerated or
    removed through `pnpm patch` / `pnpm patch-commit`, never by hand.
  - **Tooling: `gh` is installed and logged in as `lalexdotcom` since 2026-09-28** (scopes `repo`,
    `read:org`, `workflow`, `gist`, `user`), seeded at each attach from the host's credential
    (`mem:stack-and-build`, "Devcontainer"). The fork clone lives at `.work/wa-sqlite` and pushes
    through the VS Code credential helper. Anything outward-facing through `gh` — a fork, a comment,
    a PR — still waits for the user's go. Reading Actions logs through `gh` is untested; it was
    refused without a token. **`gh` cannot re-request a review upstream** (2026-09-30):
    `requested_reviewers` answers 404 and `gh pr edit --add-reviewer` is refused for lack of
    permission, so that click is the user's.

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
  the second attempt. **Trusted publishing (OIDC) is adopted since 2026-10-06 (user)**, reversing
  the 2026-09-03 refusal, whose only reason — `npm dist-tag` outside OIDC — was lifted by
  [npm/cli#10038](https://github.com/npm/cli/pull/10038) (npm 11.21.0 / 12.2.0, closing
  [npm/cli#8547](https://github.com/npm/cli/issues/8547)); and npm withdraws 2FA-bypass tokens
  (management since August 2026, direct publish targeted for January 2027,
  [community#201329](https://github.com/orgs/community/discussions/201329)). In place: the
  trusted publisher on npmjs.com (`lalexdotcom/browser-sqlite`, `release-and-publish.yaml`, no
  environment, `npm publish` and `npm dist-tag` allowed); the action at `v3.1.0` publishes
  through OIDC when the job has `id-token: write`, upgrading npm when needed, `npm-token` as the
  fallback; and the `release` job has `id-token: write`. **rc.6 (2026-10-06) was its first release:**
  `npm publish` went through OIDC — **proven by the registry, not by the log**: `npm view browser-sqlite@<v> _npmUser` reads `GitHub Actions <npm-oidc-no-reply@github.com>` for rc.6 and rc.7, against `lalexdotcom` for rc.5 (checked 2026-10-06). The action's "trusted publishing (OIDC), npm-token as fallback" line only says OIDC is AVAILABLE. **npm's notice on 2FA-bypass tokens proves nothing either**: rc.7 printed it during `npm publish` too, which the registry shows went through OIDC — it appears whenever a token is configured, used or not. So what the two `npm dist-tag add` authenticated with is unknown: the registry records no publisher for a dist-tag. **The next release answers it: since 2026-10-06 (user) `release-and-publish.yaml` no longer passes `npm-token` to the action** — the line is commented out, not deleted, with a note to restore it if the dist-tags cannot move. Read that run's `Update dist-tags` step and `npm view browser-sqlite dist-tags` after it; `npm publish --tag` sets the channel's own tag at publish time, so a failure would show as `latest`/`next` not moving. **Once that is shown:** drop
  `npm-token` from the workflow, delete the `NPM_TOKEN` secret, and switch the package's
  publishing access to "disallow bypass 2fa tokens" (both the user's). Until then the `NPM_TOKEN` secret stays in the repository, unused by the workflow, and it **runs out around 2026-11-29** (renewed for 90 days at rc.4's release,
  user 2026-09-05; derived, not read off npm).

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

- **Every published version up to `1.0.0-rc.7` holds memory on Firefox that the next release frees (fixed on `main` 2026-10-07, unreleased).** `stream()`, `chunk()` and `tx.stream()` keep every chunk until the client closes (~2 GB for a 500 MiB read), and every query of any kind keeps ~0.9 KB for its worker's life (~180 MB per 200 000 queries on one worker); measured in a Firefox launched without Playwright, Chromium not affected. Both are `### Fixed` in `## [Unreleased]`; numbers in STREAM-FF, `mem:measurements/footprint`. Nothing to do but release.

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
    load-bearing. `buildRef()` in `scripts/bench/assemble.ts` is not decoration. The preview
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
