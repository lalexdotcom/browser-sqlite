# State — where the work stands

**Updated 2026-08-27.** Rewrite this whole file when it stops being true; do not append a
new dated section under the old one.

**No SHAs, no commit counts, no branch names here (user, 2026-08-27).** `git log`,
`git status` and `git branch` answer all of that in one command and always correctly, while
a copy here rots — it did three times in a single day, on the same file, naming a stale
HEAD, a stale count and a conformance result that a fix had already changed. `mem:index`
already says it: these memories carry what cannot be re-derived. This file is decisions,
obligations and unmeasured ground.

## Standing facts about the repository

- **`main` sits ahead of `origin/main` on purpose, indefinitely.** Pushing is not part of
  committing (`mem:conventions`). Do not push as housekeeping, and do not read the distance
  as an oversight.
- **`package.json` stays at `1.0.0-rc.3` until the user says otherwise.** The bump is
  theirs to call; everything lands in the unreleased section of `CHANGELOG.md`, which is
  where to read the delta since the published rc.3 of 2026-03-26.
- **Feature branches are merged with `--no-ff`** and a body explaining the change, matching
  every previous merge.

## The verification baseline — compare against these, 2026-08-28

Not history: the numbers a regression is detected against.

`tsc --noEmit` clean · `pnpm build` clean · **428 tests, 0 failed files** ·
conformance **73 passed / 12 skipped on Chromium and the same on Firefox** ·
**consumer smoke 24/24** · `scripts/bench/check.mjs chromium --all` OK, 22 pairs,
zero `not-run` · biome 13 warnings, none in recently touched files ·
`dependencies` empty.

**Read four fields from a test report, not three.** `status` and `failedFiles`
show an unhandled rejection escaping outside any test, which the per-test
counters cannot. That was reported green once — see `mem:lessons`.

Firefox conformance was 57/19 until `OPFSWriteAheadVFS`'s declaration was corrected; the
two engines agreeing is the current expectation, and a divergence means something skipped.

**Firefox's browser project is 427/428, not 428.** `long-query :: does not block the pool`
is the flake at 1/3 that `mem:follow-ups` carries with its three runs. Expect it; a *second*
Firefox failure is the signal.

## Decisions the user owes

None outstanding, and **nothing is designed-and-approved-but-unbuilt** —
`PREPARE-1`, the statement cache, shipped on 2026-08-28 and took the slot from
`BACKPRESSURE-1`. The next item is whatever the user picks from
`mem:follow-ups`.

## Owed before the release

**Scope, set by the user on 2026-08-27, and stated twice because the first
reading was wrong.** rc.4 closes every open point that does not *touch* multi-tab,
**and documents multi-tab as it stands, limitations included** — the Known
Limitations line is rc.4 work, not rc.5. rc.5 is where multi-tab is studied for
feasibility and either built or abandoned. Anything that would *change* multi-tab
behaviour waits for rc.5; describing today's behaviour does not.

- Bump `package.json` to `1.0.0-rc.4`.
- **The upstream PR is open and the ball is in the maintainer's court:
  `rhashimoto/wa-sqlite#344`**, "Fix OPFSAnyContextVFS writes on WebKit by
  copying the page buffer", from `lalexdotcom`. rhashimoto reviewed it on
  2026-08-27: he will merge on two conditions — a link to a filed WebKit bug,
  and the original `.subarray()` line kept commented out above a TODO, because
  he refuses to slow conforming browsers for a non-conforming one without a
  trail back. **Both were satisfied on 2026-08-28** and the reply was posted by
  the user; nothing is owed upstream until he answers.
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
    still needs the user — no token in this container.

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
- **`no-read-inside-transaction` and `survives-reopen` both flip between runs.** n≥3 per
  device before either is cited — `mem:follow-ups` carries the counts.
- **The benchmark page cannot report whether the OPFS root was empty when a run started.**
  That gap is what let a hand-clearing be mistaken for evidence; a run inventorying the
  root in its export would close it. Nobody has done it.

## Known live exposures

- **One Pages site per repo, last deploy wins.** A manual dispatch from any `feat/*` branch
  replaces whatever the last release published. Kept deliberately (2026-08-26, user):
  dispatching onto a real device without merging is worth the exposure — which is what
  makes the page's "development build" banner load-bearing. `buildRef()` in
  `scripts/bench/assemble.mjs` is not decoration.
- **The pinned Vite 6 consumer fixture is the only thing verifying the README's one
  instruction.** `tests/consumer` resolves to the newest Vite, where `optimizeDeps.exclude`
  is a no-op. Delete `tests/consumer-vite6` and that line goes back to unverified prose.
- **The Parcel fixture is what keeps `main` in `package.json` alive.** Parcel is the only
  resolver in the smoke that ignores `exports`; without the fixture the field reads as dead
  weight and will be deleted.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped,
`mem:measurements` for every number this project owns.
