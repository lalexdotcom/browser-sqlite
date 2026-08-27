# State — where the work stands

**Updated 2026-08-27.** Rewrite this whole file when it stops being true; do not append
a new dated section under the old one.

## Right now

`main` is at `15a6c56`, **48 commits ahead of `origin/main`**, working tree clean —
deliberately unpushed, per `mem:conventions`.

`package.json` still says `1.0.0-rc.3`. **The bump is the user's explicit call and has not
been made** — until they say so, everything lands in the unreleased section of
`CHANGELOG.md`.

Verified 2026-08-27: `tsc --noEmit` clean, `pnpm build` clean, **350 tests**, conformance
**66 passed / 10 skipped** on Chromium and **57 / 19** on Firefox, **consumer smoke 24/24**,
`scripts/bench/check.mjs` OK, `dependencies` empty.

**The published version is 1.0.0-rc.3 (2026-03-26).** Everything since is unreleased;
`CHANGELOG.md` carries that delta and is the place to read it, not this file.

## What this session shipped, `43f8572..15a6c56`

1. **`pool.ts`'s duplicate worker.** A second, bare
   `new URL('./worker/worker.js', import.meta.url)` fed only an error-message fallback, and
   made every Vite consumer ship a **777 kB untransformed copy** of the worker with dangling
   `.wasm` references that nothing ever loads. Removed. The message now names
   `import.meta.url` when `ErrorEvent.filename` is empty — which is what Chromium does, and
   the reason the fallback existed. A bare `import.meta.url` is not an asset reference, so
   it costs nothing.
2. **Bundler coverage.** `main` added to `package.json`; three new fixtures
   (`consumer-vite6`, `consumer-webpack`, `consumer-parcel`); rsbuild dev added; the smoke
   goes 11 → **24 stages**, five bundlers, dev *and* build each. README's Bundler
   Configuration cut from 36 lines to four sentences. Details in `mem:stack-and-build`,
   numbers in `mem:measurements`.
3. **Build output.** `minify` and `sourceMap` on both entries, and `LICENSE` copied into
   `dist/` beside `NOTICE`.

## Decisions the user owes

- **The `readwrite-unsafe` guard.** It cannot be probed synchronously, so the client guard
  cannot catch `OPFSWriteAheadVFS` failing off Chromium; the README entry is its only
  defence. Accept that and delete the item, or design an async probe? Raised 2026-08-26,
  still open. Note `tests/unit/capabilities.test.ts` holds a falsifiable pin on the current
  semantics — changing `missingFeature`'s contract reddens it, which is the tripwire.
- **The backlog triage in `mem:follow-ups`** was proposed 2026-08-26 and is still awaiting
  a decision; nothing has been deleted on its strength.

**D6 is closed** — its premise was measured false, see `mem:follow-ups`. `wasmUrl` survives
it as the remaining designed-but-unbuilt item, and the user has said it comes next.

## Owed before the release

- Bump `package.json` to `1.0.0-rc.4`.

**The four unreviewed commits `d2af8a2..a22bd48` are done** — reviewed 2026-08-27, findings
verified against `main` rather than taken at face value: two "Critical" were already fixed
by later commits, and the three that survived shipped in `0c83d32` and `2188bbf`.

## Owed, no work started

- `ABORT-1`, `DELETE-1`, `RESIDUE-1` — each needs its own design, none started.
- `FLAKE-ROW-1` needs n≥3 per engine before the `OPFSCoopSyncVFS` README entry can be
  defended as written.
- The upstream wa-sqlite PR is pushed to `lalexdotcom/wa-sqlite` (branch
  `fix/opfs-anycontext-webkit-view-offset`, `28a090d`) but **not opened**. Body drafted at
  `.work/PR-body.md`, gitignored.
- Re-run the device campaign on Safari 27, iOS 26 and iPadOS 27 **with the WebKit patch**.
  Only Safari 26.5.2 has been measured against it.

## Known live exposures

- **One Pages site per repo, last deploy wins.** A manual dispatch from any `feat/*` branch
  replaces whatever the last release published. Kept deliberately (2026-08-26, user)
  because dispatching onto a real device without merging is worth the exposure — but that
  makes the page's "development build" banner load-bearing. `buildRef()` in
  `scripts/bench/assemble.mjs` is not decoration.
- **The Vite 6 fixture is the only thing verifying the README's one instruction.** Delete
  `tests/consumer-vite6` and that line goes back to being unverified prose.

Related: `mem:follow-ups` for the backlog, `mem:history` for what each wave shipped.
