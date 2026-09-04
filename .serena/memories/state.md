# State — where the work stands

**Updated 2026-09-03.** Rewrite this whole file when it stops being true; do not append a
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

## The verification baseline — compare against these, re-measured 2026-09-03

Not history: the numbers a regression is detected against. **Every figure below was read off
a run on 2026-09-03 in this container, on the MERGED result** — none is carried forward from
an earlier session, and none is arithmetic — every row was re-read after the OPEN-TIMEOUT
merge, `check.mjs` included, so no row is now carried over.

| command | result |
|---|---|
| `pnpm exec tsc --noEmit` | clean |
| `pnpm build` | clean |
| `pnpm test` | **TWO reports since 2026-09-03** — it chains both engines. `status: pass` on each: **613 tests / 47 files** (unit + chromium), then **225 tests / 30 files** (firefox) |
| `pnpm test:unit` | 389 tests, 18 files |
| `pnpm test:chromium` | 224 tests, 29 files |
| `pnpm test:firefox` | 225 tests, 30 files — the 29 shared plus one Firefox-only |
| `pnpm test:conformance` | **TWO reports** — it chains both engines. 85 tests / 2 files, **73 passed / 12 skipped**, on each: identical |
| `pnpm test:consumer` | 24/24 stages |
| `node scripts/bench/check.mjs chromium --all` | OK, 22 declared pairs, 22 columns, zero `not-run` |
| `pnpm lint` | 97 files, 13 warnings, 1 info |
| `dependencies` in `package.json` | absent |

**The per-project split is here on purpose.** A total alone cannot say which suite moved, and
the totals are what rot: this file carried "the browser project is 158/158" from 2026-08-28
until 2026-09-02, by which point the same command was reading well over two hundred — several
rc.5 lots had added browser tests and nobody re-read the line. **Re-measure the whole table
when you touch it; do not patch one cell.**

**Read four fields from a test report, not three.** `status` and `failedFiles`
show an unhandled rejection escaping outside any test, which the per-test
counters cannot. That was reported green once — see `mem:lessons`.

Firefox conformance was 57/19 until `OPFSWriteAheadVFS`'s declaration was corrected; the
two engines agreeing is the current expectation, and a divergence means something skipped.
As of 2026-09-03 they agree on **both** suites, test for test — conformance and the browser
project alike.

**Firefox is a CI gate since 2026-08-28, and since 2026-09-03 it is inside `pnpm test`**
rather than a step of its own — `TEST_BROWSER` is gone, and a local run covers what CI covers. The two flakes this file used to warn about are gone: `long-query :: does not
block the pool` was never a pool defect (it timed the FILE — see `mem:follow-ups`), and
`barrier` did not reproduce in 13 consecutive runs. **A failure on the Firefox step is
signal, not noise** — it is the only step that drives the pool against a rotating exclusive
OPFS handle, so it is where a reduced-mode regression lands first. The 13-run campaign was
one machine and one build; slower CI hardware may still surface timing the campaign did not.

## Decisions the user owes

None outstanding.

**The next thing is rc.5's remaining scope, which is the user's to pick from
`mem:follow-ups`.**

## rc.5 so far: eight lots, merged 2026-09-02 to 2026-09-04

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
  - **What is pending is a wa-sqlite RELEASE, and there was none as of
    2026-08-31 (user).** The re-vendoring waits for it: until wa-sqlite publishes
    a version carrying the fix, `patches/wa-sqlite@1.1.1.patch` stays exactly as
    it is. Do not remove it early and do not hand-edit it (see below).
  - **The WebKit bug already existed — do not file another one.**
    <https://bugs.webkit.org/show_bug.cgi?id=302733>, "FileSystemWritableFileStream.write()
    ignores byteOffset when writing TypedArray subarrays", Website Storage,
    still `NEW`, filed 2025-11-18, radar `rdar://problem/165411850`. It is our
    exact case and the report itself names `.slice()` as the workaround, so the
    patch is the sanctioned fix, not a guess. A second reporter extended it to
    `DataView` on 2026-08-24. No WebKit PR touches it.
  - `patches/wa-sqlite@1.1.1.patch` carries the same TODO and link as the
    upstream commit and must keep doing so — regenerate it with `pnpm patch` /
    `pnpm patch-commit`, never by hand, or the lock's patch hash and the file
    disagree.
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
  guard against a silent expiry is watching the token's expiry date by hand.

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

- **The Pages site is a pure function of TWO TAGS, and this file said otherwise until
  2026-09-03.** `/` is built from the latest release tag, `/preview/` from the `preview` tag,
  and the ref that TRIGGERED a run is never built. So `/` cannot drift to unreleased code and
  a preview cannot survive as a mystery. The old wording here — "last deploy wins, a manual
  dispatch from any `feat/*` branch replaces it" — is wrong on both halves: there is no manual
  dispatch, and a preview does not replace the release page. Read the header of
  `.github/workflows/pages.yaml`, which is authoritative.
  - **Moving the tag is the whole gesture**, and re-pushing it unchanged is how you
    republish: `git tag -f preview <sha> && git push -f origin preview`. Deleting the tag
    takes the preview down. Both need `main` allowed in the `github-pages` environment,
    because a `delete` run executes from the default branch.
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
