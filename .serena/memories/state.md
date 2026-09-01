# State — where the work stands

**Updated 2026-08-31.** Rewrite this whole file when it stops being true; do not append a
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

## The verification baseline — compare against these, re-verified 2026-08-31

Not history: the numbers a regression is detected against.

`tsc --noEmit` clean · `pnpm build` clean · **500 tests, 0 failed files** on the
cross-tab branch (470 on `main`) · conformance **73 passed / 12 skipped on Chromium and
the same on Firefox** · **consumer smoke 24/24** ·
`scripts/bench/check.mjs chromium --all` OK, 22 pairs, zero `not-run` ·
biome 13 warnings, none in recently touched files · `dependencies` empty.

**Read four fields from a test report, not three.** `status` and `failedFiles`
show an unhandled rejection escaping outside any test, which the per-test
counters cannot. That was reported green once — see `mem:lessons`.

Firefox conformance was 57/19 until `OPFSWriteAheadVFS`'s declaration was corrected; the
two engines agreeing is the current expectation, and a divergence means something skipped.

**Firefox is a CI gate since 2026-08-28, and its browser project is 158/158 like
Chromium's.** It runs as its own step in `ci.yaml`, after `pnpm test`. The two
flakes this file used to warn about are gone: `long-query :: does not block the
pool` was never a pool defect (it timed the FILE — see `mem:follow-ups`), and
`barrier` did not reproduce in 13 consecutive runs. **A failure on the Firefox
step is signal, not noise** — it is the only step that drives the pool against a
rotating exclusive OPFS handle, so it is where a reduced-mode regression lands
first. The 13-run campaign was one machine and one build; slower CI hardware may
still surface timing the campaign did not.

## Decisions the user owes

**One: whether to merge the cross-tab branch**, which is finished and reviewed clean. Nothing
else is outstanding.

## rc.5's first item: built, reviewed, unmerged

**Multi-client / multi-tab, both halves, delivered 2026-09-01.** Writes serialize across every
client and tab in the origin; read-your-own-writes holds across tabs on every VFS but
`IDBMirrorVFS`. Spec, plan and mechanism: `mem:architecture`'s cross-tab section and
`docs/superpowers/specs/2026-08-31-cross-tab-coordination-design.md`. **Read the spec, not a
summary** — it carries an amendment made during implementation.

The branch is **unmerged and not pushed**; `git branch` names it. Its baseline: **500 tests,
0 failed files**, both engines, conformance 73/12, biome 13 warnings.

**What it does NOT deliver, and the README says so:** reads still wait on the rotated
exclusive OPFS handle wherever `readwrite-unsafe` is missing — serializing writers does not
change which handle a VFS holds. `IDBMirrorVFS` gains nothing cross-tab and cannot.
`OPFSCoopSyncVFS`'s stalls are untouched.

**Unverified, and worth knowing before promising anything:** nobody has checked whether two
tabs can even *open* the same database on the VFS declared `multiConnection: false`
(`AccessHandlePoolVFS`, `IDBMirrorVFS`). Serializing writers is moot if the second tab never
opens.

**A behaviour change consumers can depend on:** two clients writing at once no longer produce
`BUSY` — the second waits. Code that caught `BUSY` between a consumer's own clients and
retried is now unreachable. It is in `CHANGELOG.md` under Breaking for that reason, even
though nothing stops compiling.

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
  the second attempt. `mem:follow-ups` carries trusted publishing as the rc.5
  answer, with the reason it does not fully remove the token here.

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
- **`survives-reopen` flips between runs**; n≥3 per device before it is cited, and
  `mem:follow-ups` carries the counts (REOPEN-1). `no-read-inside-transaction` does
  **not** flip at n=3 per engine in this container — measured 2026-08-31, table in
  `mem:measurements`, which is also where the unreachable WebKit flip is recorded.
- **The benchmark page cannot report whether the OPFS root was empty when a run started.**
  That gap is what let a hand-clearing be mistaken for evidence; a run inventorying the
  root in its export would close it. Nobody has done it.

## Known live exposures

- **One Pages site per repo, last deploy wins.** It currently carries the rc.4
  release build, deployed by the release itself. A manual dispatch from any
  `feat/*` branch replaces it. Kept deliberately (2026-08-26, user): dispatching
  onto a real device without merging is worth the exposure — which is what makes
  the page's "development build" banner load-bearing. `buildRef()` in
  `scripts/bench/assemble.mjs` is not decoration.
- **The pinned Vite 6 consumer fixture is the only thing verifying the README's one
  instruction.** `tests/consumer` resolves to the newest Vite, where `optimizeDeps.exclude`
  is a no-op. Delete `tests/consumer-vite6` and that line goes back to unverified prose.
- **The Parcel fixture is what keeps `main` in `package.json` alive.** Parcel is the only
  resolver in the smoke that ignores `exports`; without the fixture the field reads as dead
  weight and will be deleted.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped,
`mem:measurements` for every number this project owns.
