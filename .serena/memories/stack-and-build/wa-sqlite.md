# Stack — the vendored wa-sqlite: pin, patch, fork

Part of `mem:stack-and-build`. Moved here from it on 2026-10-08; the chain of earlier pins was cut (git and `mem:history` carry it), the rest moved as written. What was sent upstream, and why: `mem:upstream`.

## The pin

`wa-sqlite` is a devDependency only, vendored into `dist/worker/worker.js` at build time so it
never reaches a consumer lockfile. **Pinned by commit SHA, not by tag, since 2026-09-15 (user)**:
`github:rhashimoto/wa-sqlite#96d91182bf958d1c9fce2d851f66198378d8dbf1` since 2026-10-05, upstream
`master` with our #375 merged, byte-identical to the head the patch carried; the repin also brought
what the patch had left out of #375, the `async` glue and a rebuilt `wa-sqlite-async.wasm` (no
`asyncify_imports.json` any more), so `async` executes new code since. Vendored, so a commit serves
as well as a release and nothing waits for one.

- **A repin can change executed code even when the PRs it brings were carried**: a PR merged at a
  later head than the patch held (#363 and #369 on 2026-10-03) or a part of a PR the patch left out
  (#375's glue) reaches `dist/` only through the repin. Compare `dist/` across it.
- **#330 (in since the 2026-09-21 repin) changes what a failed open reports** — SQLite's own
  `unable to open database file` instead of the function name (CHANGELOG under Changed). It also
  stops a failed `sqlite3_open_v2` leaking the database handle SQLite allocates for it —
  `openWithRetry` can make 25 attempts, each of which leaked before.

## The patch

**`patches/wa-sqlite@1.1.2.patch` carries the upstream changes listed below, file by file**, and is
no longer deletable as a block. Each is independent and each has a report in
`docs/upstream/`, which is where the mechanisms and measurements live:

- `IDBMirrorVFS.js` — #371 (a commit whose IndexedDB transaction aborts: commits built on it refused
  or dropped, the view reloaded from IndexedDB, `SQLITE_BUSY` at RESERVED, the journal of an aborted
  view removed on close), head `3367cb65` since 2026-10-03; and #372 (`jClose` waits for the commits in
  flight before closing the `BroadcastChannel`), head `69e00270` since 2026-10-03. The two PRs conflict
  in `jClose` only: the patch waits for the commits in flight first, then removes an aborted view's
  journal. Both PRs' tests pass on the merged file (226, 3/3, both engines).
- `OPFSAdaptiveVFS.js` — #374, line 9 guarded (`FileSystemSyncAccessHandle?.prototype`), without
  which no worker loads outside a secure context (INSECURE-CONTEXT).
- `dist/wa-sqlite-jspi.mjs` was carried for #375 from 2026-10-05 until its merge the same day. **After any change to a carried `dist/` glue, clear `node_modules/.cache/rspack` and check the pattern in `dist/worker/worker.js`**: the forced build cache served the previous glue once.
- `IDBMirrorVFS.js` and that line are all the patch holds: every other PR it carried has merged.

`WriteAhead.js` is no longer patched: #365 (`PRAGMA wal_read_latest`, which the library's barrier
sets) and #361 are upstream. #366 changes tests only and is not carried.

**When one merges, repin and regenerate the patch WITHOUT that PR's hunks — do not delete the
file.** The hunks sit in different regions and, for two of them, different files, so a selective
removal is mechanical; `pnpm patch` then `patch -p1 < patches/…` first, as below.
- **The `wa-sqlite` on npmjs is not the upstream package**: `1.0.0`, published by
  `gabrieldevunstatic <tailinh@unstatic.co>`, no `repository` field. Never point at it.
- **Upstream's tags do not follow its versions.** `v1.1.2` points at `2bf1c59`, whose
  `package.json` says `1.1.1`; the bump to `1.1.2` and #344 came after it. The patch key is the
  `version` field of the resolved commit — `wa-sqlite@1.1.2` today. Verify by commit.
- **A branch switch that changes the patch reinstalls by itself since 2026-09-29** — the
  `post-checkout` hook (`mem:git-hooks`), with its trap for branches that predate it.
- **`pnpm patch` (10.31) does NOT re-apply the existing patch** in its edit directory: apply it by
  hand (`patch -p1 < patches/…`) before editing, or `patch-commit` silently drops what the old patch
  held. **After a change of patch key, `patch-commit` left `node_modules` unpatched** — the `.pnpm`
  directory had no patch-hash suffix and the lockfile no `patchedDependencies` — until a second
  `pnpm install`. Check both before trusting a run.
- **A repin rebuilds the patch from the PR heads, then checks it (2026-09-26).** In a detached
  worktree of the new pin, apply each carried PR's `git diff $(merge-base) <head> -- src/` with
  `git apply --3way`; write that diff as the patch, `pnpm install`, then round-trip it through
  `pnpm patch` / `patch -p1` / `patch-commit` so pnpm writes it. Proof: `diff -r` of the worktree's
  `src/` against `node_modules/wa-sqlite/src` (only build sources absent from the package may
  differ) and of `dist/`. A stale `node_modules/.pnpm_patches/wa-sqlite@1.1.2` makes `pnpm patch`
  refuse: pass `--edit-dir` elsewhere rather than deleting what is in it.

## The wa-sqlite fork and its test suite

`.work/wa-sqlite` is the user's fork (`origin` = `lalexdotcom/wa-sqlite`), with `upstream` =
`rhashimoto/wa-sqlite` added on 2026-09-15. It pushes through the VS Code credential helper; opening
a PR is the user's. Its suite runs with yarn 4 (PnP, pinned by `.yarnrc.yml`'s `yarnPath`):
`yarn install`, then `CHROME_PATH=~/.cache/ms-playwright/chromium-1234/chrome-linux/chrome yarn
web-test-runner test/OPFSCoopSyncVFS.test.js` — Chrome only; the whole suite is `yarn test`, ~40 s
and 2 899 tests on 2026-09-15.

**What that runner prints, read on 2026-09-30.** Its totals count assertions, not tests, and it names a test only when it fails — `summaryReporter` prints `undefined`, the jasmine adapter passes no names. So a green total cannot show which builds ran, and a branch older than upstream's `51784ebf` skips every `jspi` test silently (`mem:lessons`). **The proof that a build ran is a red arm**: the same test file against `master`'s VFS, in a detached worktree, fails once per build and names it. The whole suite was 15 files in 80 s that day, both builds running (`mem:measurements`, 352-353-REVIEW). A worktree of the fork needs `node_modules` linked to the main clone's, and the clone has no git identity of its own: pass the library's with `git -c user.name=… -c user.email=…`.

**In that suite `'default'` names the synchronous build (`dist/wa-sqlite.mjs`)**, and it is
`TestContext`'s default. `OPFSWriteAheadVFS`, like the IndexedDB VFS and `OPFSAdaptiveVFS`, runs
only on `asyncify`/`jspi`: its own test file and `api.test.js`/`sql.test.js` list it under their
async builds, although it exposes only synchronous methods and we run it on `sync` first. A test
written for that VFS there covers the default build only if it adds it. For probes outside the
suite (Firefox included), a Playwright `launchPersistentContext` script serving `.work/` works.

**`npm install` works there too and is what four PRs of 2026-09-18 used** —
`npx web-test-runner --config web-test-runner.config.mjs --files './test/<VFS>.test.js'`, same
`CHROME_PATH`. Two traps paid for that day: `npm install` **rewrites `yarn.lock`** (restore it
before committing), and `git stash -u` **takes `node_modules` with it**, after which the runner
dies with `ERR_MODULE_NOT_FOUND` rather than anything explanatory.

**A test that calls the VFS directly cannot see a `Uint8ArrayProxy` defect.** Comlink clones
what crosses to the worker, so `proxy.vfs.jWrite(...)` receives a real `Uint8Array`; the proxy
only appears when SQLite calls the VFS from WebAssembly. #352's first test was written that way
and passed against the bug — the falsifier had to go through SQL. Three facts that cost time:

- **`TestContext.create()` never rejects**: a worker that fails to start throws from the message
  listener and the promise stays pending. `test/vfs_handover.js` starts its workers through a helper
  that does reject.
- **`TestContext.supportsJSPI()` builds a `WebAssembly.Function`**, gone from Chrome 151 (which has
  `WebAssembly.Suspending` and `promising`), so every `jspi` describe is skipped locally.
- **Upstream CI** (`.github/workflows/ci.yml`) runs `yarn test` on Chrome 129, then rebuilds the WASM
  with Emscripten 3.1.61 and runs it again. It starts on a PR from the fork without approval. Its
  job steps are readable through the public API (`/actions/runs/<id>/jobs`); its logs are not.
