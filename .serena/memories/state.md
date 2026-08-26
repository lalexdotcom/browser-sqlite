# State — where the work stands

**Updated 2026-08-26.** Rewrite this whole file when it stops being true; do not append
a new dated section under the old one.

## Right now

**`feat/tx-query-surface` is complete and awaiting the merge decision** — 15 commits,
not merged, not pushed. `main` is at `d92ac71` and carries the memory reorganisation.
`package.json` still says `1.0.0-rc.3`; the bump to rc.4 is the user's explicit call and
has not been made.

Verified on the branch, 2026-08-26: `tsc --noEmit` clean, `pnpm build` clean,
**348 tests**, conformance 66 passed / 10 skipped, consumer smoke 11/11,
`scripts/bench/check.mjs` OK. `dependencies` still empty.

**The published version is 1.0.0-rc.3 (2026-03-26).** Everything since — waves 0 to 4,
the VFS branch, the RYOW barrier, the benchmark page, the capability guard, and this
branch — is unreleased. `CHANGELOG.md` carries that delta and is the place to read it,
not this file.

## Last branch — `feat/tx-query-surface` (2026-08-26)

**A transaction now carries the client's whole querying surface.** Before it, a caller who
wanted to load rows atomically into an *existing* table had no path at all: `output()` only
replaces a table, `bulkWrite()` commits per batch, and the transaction surface offered
neither. `db.bulkWrite` stays streaming and non-atomic; `tx.bulkWrite` is bounded by the
callback and rolls back with it.

Four shapes worth not undoing:

- **`SQLiteQueryAPI` is the shared base, and `tests/unit/exports.test.ts` pins it
  bidirectionally.** The pin compares `Omit<SQLiteDB, extras>` against
  `Omit<SQLiteTransactionDB, extras>` in **both** directions. A one-directional check —
  "each surface is a superset of the base" — looks equivalent and is not: it stays green
  when a method is added to one surface alone, which is exactly the drift the base exists
  to prevent. **When a member moves between the base and a surface, its name must move in
  or out of the extras lists**, or the pin silently stops watching it.
- **`api.ts` is re-exported wholesale by `index.ts`.** That is deliberate: `types.ts` needs
  a name list, and a name list is what someone forgets — which is how `SQLiteQueryOptions`
  and `TransactionDB` ended up in the shipped `.d.ts` with no way for a consumer to name
  them.
- **`createBulk` is two stages, and the sweep memo lives in the outer one.** A transaction
  builds its own target; a per-target memo would sweep on every `tx.output()` instead of
  once per client.
- **The sweep never waits.** `locks.tryWithLock` asks with `ifAvailable`. Waiting on that
  lock inside an open transaction is a deadlock — reachable with **two clients in one tab**,
  which the barrier already supports and tests. One behaviour everywhere beats an
  "am I in a transaction?" flag threaded through the injection seam.

## Previous branch — `feat/vfs-required` (2026-08-26)

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

- ~~The benchmark page is a package consumer with no compile-time guard.~~ **Closed
  2026-08-26 (`de3abdf`).** `tests/unit/exports.test.ts` now asserts that every name the
  page — and `tests/consumer-nobundler/index.html` — imports from `dist/index.js` exists on
  the package entry. Public exports no longer have to be checked against the page by hand.
  Add any new by-path importer to that test's `PATH_IMPORTERS` list.
- **One Pages site per repo, last deploy wins.** A manual dispatch from any `feat/*`
  branch replaces whatever the last release published. The rule was kept deliberately
  (2026-08-26, user) because dispatching onto a real device without merging is worth the
  exposure — but that makes the page's "development build" banner load-bearing.
  `buildRef()` in `scripts/bench/assemble.mjs` is not decoration.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped.
