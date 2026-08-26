# State — where the work stands

**Updated 2026-08-26.** Rewrite this whole file when it stops being true; do not append
a new dated section under the old one.

## Right now

`main` at `1783db7`, working tree clean, **not pushed** — `origin/main` sits behind on
purpose (see `mem:conventions`). `package.json` still says `1.0.0-rc.3`; the bump to
rc.4 has not been made.

Last verified green on `main` (2026-08-24): `tsc --noEmit`, `biome check`, `pnpm build`,
**308 tests** (unit + browser), consumer smoke 11/11. The conformance suite and the
consumer smoke run on demand, not on every change.

**The published version is 1.0.0-rc.3 (2026-03-26).** Everything since — waves 0 to 4,
the VFS branch, the RYOW barrier, the benchmark page, the capability guard — is
unreleased. `CHANGELOG.md` carries that delta and is the place to read it, not this file.

## Last branch merged — `feat/vfs-required` (2026-08-26)

`vfs` is now required, and `src/capabilities.ts` holds the platform probes the library
had declared but never run. One change, not two: a VFS decides where the bytes live, so a
default that moves between versions leaves a consumer reading an empty database while
their data sits in a store nothing queries.

Three shapes worth not undoing:

- **`missingFeature(vfs, build, available)` is pure and takes the feature set** rather
  than probing. The branches worth testing are the negative ones, and they are
  unreachable in a real browser — JSPI cannot be taken away from Chromium.
- **`BUILD_REQUIREMENTS` carries `satisfies Record<SQLiteBuild, …>` and `SQLiteBuild`
  stays a literal union.** That direction is what makes a new build fail to compile until
  its requirements are declared. Do not "uniformise" it with
  `SQLiteVFS = keyof typeof VFS_CAPABILITIES`: that table *is* the VFS registry, this one
  describes one attribute of builds, and the build registry is `WA_SQLITE_BUILDS` in the
  worker.
- **`RECOMMENDED_VFS` is deliberately not exported.** A consumer writing
  `vfs: RECOMMENDED_VFS` is exposed to the same displacement the day the recommendation
  changes. The name must live in the consumer's own source — which is why the benchmark
  page uses the literal `'OPFSAdaptiveVFS'` too.

## Owed before the release

- **Four commits have never been reviewed: `d2af8a2..a22bd48`.** Recorded as blocking
  rc4 on 2026-08-25 and never lifted.
- Bump `package.json` to `1.0.0-rc.4`.
- The backlog triage in `mem:follow-ups` was proposed on 2026-08-26 and is **awaiting the
  user's decision** — nothing has been deleted or acted on yet.

## Owed, no work started

- `readwrite-unsafe` has no guard, so `OPFSWriteAheadVFS` keeps its obscure off-Chromium
  failure. It is unprobeable synchronously, which is why the client cannot catch it.
- `ABORT-1`, `DELETE-1`, `RESIDUE-1` — each needs its own design, none started.
- `FLAKE-ROW-1` needs n≥3 per engine before the `OPFSCoopSyncVFS` README entry can be
  defended as written.
- `D6` — the `browser-sqlite/vite` plugin subpath — designed in 2026-08-18, never built.
- The upstream wa-sqlite PR is pushed to `lalexdotcom/wa-sqlite` (branch
  `fix/opfs-anycontext-webkit-view-offset`, `28a090d`) but **not opened**. Body drafted at
  `.work/PR-body.md`, gitignored.
- Re-run the device campaign on Safari 27, iOS 26 and iPadOS 27 **with the WebKit patch**.
  Only Safari 26.5.2 has been measured against it.

## Known live exposures

- **The benchmark page is a package consumer with no compile-time guard.** When
  `DEFAULT_VFS` stopped being exported, the page kept importing it and *nothing failed* —
  not `tsc`, not the suite, because the page is HTML that no test loads.
  `scripts/bench/check.mjs` is the only thing that would catch it and it is hand-run by
  design. **Any change to the package's public exports must be checked against the page
  by hand.** `tests/consumer-nobundler/index.html` has the same exposure.
- **One Pages site per repo, last deploy wins.** A manual dispatch from any `feat/*`
  branch replaces whatever the last release published. The rule was kept deliberately
  (2026-08-26, user) because dispatching onto a real device without merging is worth the
  exposure — but that makes the page's "development build" banner load-bearing.
  `buildRef()` in `scripts/bench/assemble.mjs` is not decoration.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped.
