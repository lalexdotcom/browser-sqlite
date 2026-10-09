# State — where the work stands

**Updated 2026-10-09.** Rewrite this whole file when it stops being true; do not append a
new dated section under the old one, and move what closes to `mem:history` rather than
keeping it here struck through (rewritten on 2026-10-08 from 38 000 characters, two thirds of
them closed subjects).

**No SHAs, no commit counts, no branch names here (user, 2026-08-27).** `git log`,
`git status` and `git branch` answer all of that in one command and always correctly, while
a copy here rots — it did three times in a single day. This file is decisions, obligations and
unmeasured ground.

## Standing facts

- **`1.0.0-rc.8` is published** (2026-10-09): on npm under `rc`, `next` and `latest`, with
  provenance, published by `GitHub Actions <npm-oidc-no-reply@github.com>`, and as a GitHub
  prerelease whose body is the CHANGELOG section for the tag. It ships the binary protocol (the
  breaking change: array params as JSON text), `INVALID_VALUE`, the `sql` tag and the Firefox
  memory fixes. `package.json` sits at `1.0.0-rc.8` until the user calls the next bump. The
  release gate — `verify`, `consumer-smoke`, 22/22 cells, then `release` — ran green first time;
  two cells (`OPFSCoopSyncVFS/async`, `MemoryAsyncVFS/jspi`) took ~17 min against 3-9 for the
  others, under the 25-minute job limit — not looked into.
  Procedure: `mem:conventions`, § Releasing.
- **The vendored wa-sqlite sits on upstream `master` of 2026-10-05** (`96d91182`, `package.json`
  has the SHA). **`patches/wa-sqlite@1.1.2.patch` carries `IDBMirrorVFS.js` for #371 and #372**
  (both open upstream, conflicting in `jClose`) **and a one-line guard in `OPFSAdaptiveVFS.js`
  for #374** (open upstream); heads and the merge in `mem:stack-and-build/wa-sqlite`, reports in
  `mem:upstream`. A patch is regenerated or removed through `pnpm patch` / `pnpm patch-commit`,
  never by hand.
- **`main` may sit ahead of `origin/main` indefinitely** — the convention, not an oversight. It
  is pushed for a release, not as housekeeping.

## The verification baseline — compare against these, re-measured 2026-10-09

Not history: the numbers a regression is detected against. **Every figure below was read off ONE
pass in this container on 2026-10-09 morning, on `main` after the `feat/sql-tag` merge** —
Playwright 1.64.0, Chromium 156 (`chromium-1248`), Firefox 157 (`firefox-1555`) — none arithmetic,
on the wa-sqlite pin `96d91182` with #371, #372 and #374 carried.

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm build` | clean |
| `pnpm test` | **THREE reports**, `status: pass` and `failedFiles: 0` on each: **1600 tests, 1592 passed, 8 skipped** (unit + the two chromium target projects), **908 tests, 904 passed, 4 skipped** (the two firefox target projects), **18 tests, none skipped** (the two isolated target projects). The chromium and firefox targets are `OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi` since the default build follows the engine |
| `pnpm exec rstest --project unit run` | **706** tests, 33 files |
| `pnpm exec rstest --project 'chromium*' run` | the two chromium target projects; the glob is required — project names are `chromium · <vfs>/<build>` and rstest's filter is anchored |
| `pnpm test:conformance` | **TWO reports** — 97 tests / 3 files each: **Chromium 83 passed / 14 skipped, Firefox 79 / 18**. Each VFS runs on its default build for the engine |
| `pnpm exec biome ci .` | exit 0 |
| `pnpm docs:vfs` | leaves `VFS.md` unchanged (`git diff --exit-code`) |
| `pnpm test:consumer` | 24/24 stages |
| `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chromium --all` | `OK`, `"reasons": {}`, 22 declared pairs runnable; the checker requires `poolSize` and `longQueryCalibration` among the keys. `bench:build`, not `build`: the checker serves `_site/`. Pass `BENCH_PORT` to leave 8099 to `bench:serve` |
| `pnpm lint` | 183 files, **4 warnings**, 1 info — the file count moves with the tree, **the warning count is the signal** |
| `dependencies` in `package.json` | absent |
| `pnpm test:matrix` | **65 of 66 cells green, 1919 s**, no re-run inside it, no timed-out cell. ~32 min. **Every cell runs `BSQ_TEST_NEEDS=skip`**. The 66th, chromium `AccessHandlePoolVFS/jspi`, failed one test with `WORKER_BUSY` and was green alone 3/3, the test alone 20/20 (`mem:follow-ups`) |

Against the previous table (2026-10-08 evening): unit 664 → 706 tests, 32 → 33 files; `pnpm test`
1534 → 1592 and 888 → 904 passed, skips unchanged; lint 180 → 183 files — all `feat/sql-tag`'s
tests and `src/sql.ts`, less `debugSQLQuery`'s. Matrix 66/66 → 65/66, the one cell above.

**Do not reconcile any of these by arithmetic; re-run, and re-measure the whole table when you
touch it — never patch one cell.** Twice in September a total here went stale or contradicted its
own prose because one cell was patched and the table was not re-read. The per-project split is
here on purpose: a total alone cannot say which suite moved.

- **`pnpm test` chains THREE configs** — chromium+unit, firefox, and the isolated project — so a
  green `pnpm test` covers what CI covers. A commit pays only the unit project; a merge or a push
  pays all three (`mem:git-hooks`).
- **A green `pnpm test` is not a green tree: run `pnpm exec tsc --noEmit` beside it** — a commit
  once landed with a failing typecheck no test run could show (`mem:lessons`).
- **Read four fields from a test report, not three.** `status` and `failedFiles` show an
  unhandled rejection escaping outside any test, which the per-test counters cannot.
- **The expected skips: 4 per Chromium project, 2 per Firefox project** — so **8** on the
  chromium report and **4** on the firefox one; count per project before comparing. On both,
  `tests/browser/abandon-gc.test.ts` needs `--expose-gc` (its header carries the CLI override that
  runs it). On Firefox, `barrier.test.ts`'s "closes the pragma the barrier opens on
  `OPFSWriteAheadVFS`" skips without `readwrite-unsafe`. On Chromium, `pool-cap.test.ts`'s three
  capped-engine tests skip where `readwrite-unsafe` exists. **Any other count is something to look
  at.**
- **The engines' conformance counts differ by design**: on Firefox two invariants skip
  `OPFSAdaptiveVFS` and `OPFSWriteAheadVFS`, which run one worker there (`oneWorkerHere` in
  `tests/conformance/helpers.ts`). Any other divergence means something skipped that should not.
- **A failure on the Firefox step is signal, not noise** — it is the only step without
  `readwrite-unsafe`, so it is where a reduced-mode regression lands first. A Firefox browser test
  that fails once on CI and passes on a re-run is not automatically noise here: a load-sensitive
  defect once reproduced about once in eighteen runs of `pnpm test` and never in isolation, and
  sixteen busy loops around a single-file Firefox run cut time-to-failure twentyfold (ABANDON-WEDGE,
  `mem:measurements/aborts`).

## In flight, and not ours to move

- **wa-sqlite's tests on stock browsers: a revised proposal was posted on Discussion #373 on
  2026-10-08, and it waits on rhashimoto.** It covers WebDriver instead of Playwright, a workflow
  per platform, a DataView race in the harness, and a skip for Safari 26. Nothing is started on
  the PR before his answer. The plan and what his answer calls for are in `mem:follow-ups`, the
  measurements in `mem:measurements/test-browsers`, and the user's principles in
  `mem:conventions` (§ Testing in browsers).
- **#371, #372 and #374 are open upstream** and carried in the patch (§ Standing facts);
  follow-ups in `mem:follow-ups`.
- **Another agent's work was paused by the user until our upstream PRs were done; the user
  relaunches it.**

## Trusted publishing — what is left, all the user's

- **Shown at rc.8 (2026-10-09): OIDC alone publishes AND moves the dist-tags.** The release job ran
  with `NODE_AUTH_TOKEN` empty; `npm publish` signed provenance and `npm dist-tag add` set
  `latest` and `next` (`+latest: browser-sqlite@1.0.0-rc.8` in the log), and the registry reads
  all three tags at rc.8. The open question of rc.7 is answered.
- **So, the user's to do:** drop the commented-out `npm-token` from `release-and-publish.yaml`,
  delete the `NPM_TOKEN` secret, and switch the package's publishing access to "disallow bypass
  2fa tokens". Until then the secret stays, unused, and it **runs out around 2026-11-29**
  (renewed for 90 days at rc.4's release, user 2026-09-05; derived, not read off npm).

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
- **rstest's pages are off-the-record**, which inflates every absolute OPFS timing taken there
  (RSTEST-OTR); no persistent-context harness is planned.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped,
`mem:measurements` for every number this project owns.
