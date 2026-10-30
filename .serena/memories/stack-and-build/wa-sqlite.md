# Stack — the vendored wa-sqlite: pin, patch, fork

Part of `mem:stack-and-build`. Moved here from it on 2026-10-08; the chain of earlier pins was cut (git and `mem:history` carry it), the rest moved as written. What was sent upstream, and why: `mem:upstream`.

## The pin

`wa-sqlite` is a devDependency only, vendored into `dist/worker/worker.js` at build time so it
never reaches a consumer lockfile. **Pinned by commit SHA, not by tag, since 2026-09-15 (user)**:
`github:rhashimoto/wa-sqlite#663368072ad30a4a90c36ec4214ab43d15ea2639` since the night of 2026-10-23
(branch `build/repin-wa-sqlite-6633680`), upstream `master` with our #382, #384 and #385 merged, each file byte
for byte the PR head the patch carried (`d6dd6ba0`, `97d0f192`, `086200d7`); only those three files moved in `src/`
across it, `dist/` not at all. Before it, `8a8bc2ee` (2026-10-23 evening),
upstream `master` with our #381 merged (squashed, `OPFSCoopSyncVFS.js` byte for byte the review head
`42bfb903` the patch carried): the installed `src/` and the built `worker.js` are byte-identical across
that repin. Before it, `6b59b231` (2026-10-23), upstream `master` with #380 merged (darshanp40: `getRoot`/`prefix` on `AccessHandlePoolVFS`, `OPFSCoopSyncVFS`,
`OPFSWriteAheadVFS`, unused here; the library's `{ lockPolicy: 'shared' }` is now copied into those
VFS's `this.options`, harmlessly). Only those three files changed in `src/` across it, `sqlite-api.js`
and `dist/` not at all, so the fast step and its fingerprints held. Before it, `6238f532` (2026-10-13), upstream
`master` with our #374 merged (squashed, its fix and test hunks byte for byte the PR's), two
dependabot bumps of `yarn.lock` before it (outside the package); no patch from then until #381 was carried on 2026-10-16 (§ The patch), and the built
`worker.js`, the three `.wasm` and `index.js` byte-identical across that repin, the source map
differing only by the package's `.pnpm` path. Before it, `94cd1e7d` (2026-10-11), upstream
`master` with our #372 merged (squashed as `91a34ef7`, its tree byte-identical to the head the patch
carried, `2e85b243`) and a dependabot bump of `yarn.lock` on top (outside the package); the built
`worker.js` and the three `.wasm` are byte-identical across that repin, only `worker.js.map` moves
(the `.pnpm` path it names). Before it, `d09953ee` (2026-10-10, #371 merged, byte-identical build
too). The pin before that, `96d91182` (2026-10-05, #375 merged),
brought what the patch had left out of #375, the `async` glue and a rebuilt `wa-sqlite-async.wasm`
(no `asyncify_imports.json` any more), so `async` executes new code since then. Vendored, so a commit serves
as well as a release and nothing waits for one.

- **A repin rewrites `[Unreleased]`**: a carried fix's entry gives way to the bump of wa-sqlite (`mem:conventions/upstream`).
- **A repin can change executed code even when the PRs it brings were carried**: a PR merged at a
  later head than the patch held (#363 and #369 on 2026-10-03) or a part of a PR the patch left out
  (#375's glue) reaches `dist/` only through the repin. Compare `dist/` across it.
- **#330 (in since the 2026-09-21 repin) changes what a failed open reports** — SQLite's own
  `unable to open database file` instead of the function name (CHANGELOG under Changed). It also
  stops a failed `sqlite3_open_v2` leaking the database handle SQLite allocates for it —
  `openWithRetry` can make 25 attempts, each of which leaked before.
- **The fast step is gone (2026-10-23, repin to `66336807`)**: `src/worker/step.ts`, its unit
  test and the fingerprints of `tests/unit/lib/wa-sqlite-pin.test.ts` were deleted, and the worker
  steps through wa-sqlite's `sqlite3.step_asap()` — our #388, carried in the patch until it merges.
  rhashimoto agreed to the API, so a revision of #388 keeps it (user). What the worker relies on:
  `step_asap()` returns a number when the call completed synchronously, a Promise otherwise (always
  on `jspi`), and throws synchronously when it returns directly; `tests/browser/pairs/step-paths.test.ts`
  checks every build through the worker.

## The patch

**Since 2026-10-30, later the same day, #388 is carried at its revision `cba3a633` with its three rebuilt `dist/*.mjs` glues** (they must travel together: without `Module.asyncMode` the revised `step_asap()` calls the bare export on Asyncify; `src/libadapters.js` is not in the npm package and is not carried). Made in `.work/patch-edit-388b`: the existing patch, then `git diff 947a3996 cba3a633 -- src/ dist/` (the `libadapters.js` hunk skipped), `patch-commit`; `sqlite-api.js`, `types/index.d.ts` and the three `.mjs` byte for byte `cba3a633`, the other five files' hunks unchanged (`index` lines aside), installed package identical to the edit directory; after clearing the rspack caches `dist/worker/worker.js` carries the three `asyncMode` assignments. **Before that, also 2026-10-30 (`perf/adaptive-keep-journal`), it carried four PRs: #389 added** (`OPFSAdaptiveVFS` keeps its journal's access handle between transactions, head `2352be7c`; report `docs/upstream/2026-10-30-wa-sqlite-389-adaptive-keep-journal.md`). Added by `pnpm patch --edit-dir .work/patch-edit-389`, `patch -p1` of the existing patch, `patch -p1` of `git diff 66336807 2352be7c -- src/`, `patch-commit`: the other six files' hunks unchanged (compared hunk by hunk, `index` lines aside), installed `src/` identical to the edit directory, installed `OPFSAdaptiveVFS.js` byte for byte the PR head, lockfile hash `ce3397b5…`; after clearing the rspack caches `dist/worker/worker.js` carries `journalAccessHandle`, and JOURNAL-PROBE on the installed package shows no `-journal` create/open/close/remove per commit in Firefox. **From the repin to `66336807` (2026-10-23 night, #382, #384, #385 merged) until then it carried three PRs:** #386 `c4f832ea`, #387 `7805bb2f` (rebased 2026-10-25 as `516b3080`, same `src/`, patch unchanged), #388 `947a3996` (`step_asap()`, added at that repin). Made in a detached worktree of the pin (`.work/wa-sqlite-repin`) by `git apply --3way` of each head's `git diff $(merge-base) <head> -- src/`, all clean; that tree's `src/` differs from the previous installed one by #388's two files only (`sqlite-api.js`, `types/index.d.ts`); upstream's suite green on it with #388's test (Chrome, 16/16 files, 8 023); the patch written as `git diff --full-index`, round-tripped through `pnpm patch --edit-dir` / `patch -p1` / `patch-commit` (same content, hash `d24a86e4…`); installed `src/` identical to the tree (`diff -r`), `dist/` identical to the previous pin's. **Before it, from the repin to `8a8bc2ee` (2026-10-23, #381 merged), it carried five PRs:** #382 `d6dd6ba0`, #384 `97d0f192`, #385 `086200d7`, #386 `c4f832ea` (rebased onto `8a8bc2ee`), #387 `7805bb2f`; same procedure as below, every diff applied clean, the combined `src/` identical to the previous pin's combined tree (`diff -r`), new patch hash `5e460f16…`, `pnpm test` 371/371 files. **Before it, from the repin of 2026-10-23 to `6b59b231`, six PRs, rebuilt from their heads:** #381 `42bfb903` (its review head), #382 `d6dd6ba0`, #384 `97d0f192`, #385 `086200d7`, #386 `a21e9d45`, #387 `7805bb2f`. Files: `WebLocksMixin.js` (#387) and `OPFSAdaptiveVFS.js` (#382), byte for byte their heads; `IDBBatchAtomicVFS.js` (#384 + #387), `IDBMirrorVFS.js` (#385 + #387) and `OPFSCoopSyncVFS.js` (#381 + #386, over #380), every line of each PR's diff present. Made in a detached worktree of the pin by `git apply --3way` of each head's `git diff $(merge-base) <head> -- src/`, all clean; upstream's suite green on that tree (Chrome, 15/15 files, 6 443); the patch written as `git diff --full-index`, round-tripped through `pnpm patch --edit-dir` / `patch -p1` / `patch-commit` (same content, hash `0f0313c2…`); installed `src/` identical to the tree (`diff -r`, build sources aside), `dist/` identical; after clearing the rspack caches the bundle shows #386's check, `getIDBFactory`, the prefixed `mirror:` channel and #381's retry. Library: `pnpm test` 371/371 files. The paragraphs below describe the patch before that repin.

**Since 2026-10-21 it also carries #384 (`IDBBatchAtomicVFS.js`, head `97d0f192`) and #385 (`IDBMirrorVFS.js`, head `086200d7`)**, the four installed files byte for byte their PR heads (`cmp`), on branch `fix/idb-vfs-close`.

**What the library builds on #384/#385 — a review that changes any of it changes the library (user, 2026-10-21: "si rhashimoto nous demande des modifs qui influent sur la lib, il faut le savoir").** Read every review comment on them against this list before answering:
- **The contract relied on:** both VFS's `close()` returns a promise that resolves only once every IndexedDB transaction the VFS started has fired `complete` or `abort` — **readonly ones included** (the delete worker's `jAccess` barrier is readonly) — and closes the `IDBDatabase`, so no new transaction can start after it (the quiesce stops a running statement that way: `IDBBatchAtomicVFS` closes after its `#chain` snapshot, `IDBMirrorVFS` at once).
- **Where:** `closeIdbVfs` in `src/worker/worker.ts` (IndexedDB storage only, bounded `IDB_CLOSE_MS` 2 s) before the `closed` reply and on `quiesce`; `deleteDatabaseFiles` closes its VFS on every outcome (unbounded). `src/worker/idb-transactions.ts` (the worker's patch of `IDBDatabase.prototype.transaction`, `refuseNew`, `settled`) was **deleted** on that strength; it is at `f4a07b3` if it must come back.
- **What would break it:** waiting for commits only (Safari strands again on the delete worker's readonly transaction); waiting in `jClose()` instead of `close()` (the delete worker and the quiesce never close a file); a separate method instead of `close()`; `close()` no longer closing the connection (the quiesce loses its refusal); #385 declined (it only matters on Safari): the library then needs its own tracking back for `IDBMirrorVFS`.
- **What would catch it:** `close.test.ts` "keeps the last write of a client closed under synchronous=NORMAL" catches a close path that stops waiting on `IDBBatchAtomicVFS` on Chrome and Firefox (red without `closeIdbVfs`: 4 of 4 pairs). Nothing on Chrome/Firefox catches a lost refusal, an `IDBMirrorVFS` regression or a readonly transaction left live: only Safari (the `spike/safari` workflow's `[pairs]`/`[kill]` jobs, or the macOS suite once it exists).

**Since 2026-10-16 `patches/wa-sqlite@1.1.2.patch` carries #381 and #382**: `OPFSCoopSyncVFS.js` and `OPFSAdaptiveVFS.js`, the `src/` hunks of the PR heads `3c75a3c8` and `d6dd6ba0`, the installed files byte for byte those heads (their test files are not carried). #382 was added by applying the existing patch then `git diff 6238f532 d6dd6ba0 -- src/` in a `pnpm patch --edit-dir` directory, then `patch-commit`; checked with `cmp` of each installed file against `git show <head>:<path>`. Made with `pnpm patch --edit-dir` outside the stale `node_modules/.pnpm_patches/wa-sqlite@1.1.2`, `patch -p1` of the PR's `git diff 6238f532 3c75a3c8 -- src/`, `pnpm patch-commit`: this time `node_modules` came out patched at once (the `.pnpm` directory with its hash suffix, `patchedDependencies` in the lockfile), and after clearing `node_modules/.cache/rspack` the retry shows in `dist/worker/worker.js`. From the repin to `6238f532` (2026-10-13) until then there was no patch: `pnpm patch-remove wa-sqlite@1.1.2` had deleted `patches/` and `patchedDependencies` — then its own install failed `ENOENT` on the file it had just deleted (pnpm 10.31), and a plain `pnpm install` finished cleanly. Below, what the patch carried before that, file by file; each change has a report in `docs/upstream/`, which is where the mechanisms and measurements live. The procedure that follows is for the next change carried before it merges:

- `IDBMirrorVFS.js` — #372 was carried from 2026-10-03 (merged with #371 until #371's merge, then
  alone, last at head `2e85b243`) and left the patch at the repin to `94cd1e7d` (2026-10-11), merged
  upstream byte for byte.
- `OPFSAdaptiveVFS.js` — #374, line 9 guarded (`FileSystemSyncAccessHandle?.prototype`), without
  which no worker loads outside a secure context (INSECURE-CONTEXT); carried from 2026-10-03, merged
  upstream on 2026-10-13 and gone with the patch at the repin to `6238f532`.
- `dist/wa-sqlite-jspi.mjs` was carried for #375 from 2026-10-05 until its merge the same day. **After any change to a carried `dist/` glue or any re-link of `node_modules/wa-sqlite` (a patch change), clear `node_modules/.cache/rspack` and `node_modules/.cache/rspack-test` (the browser tests' build: a stale one bundled two `SQLiteError` classes on 2026-10-16, so `instanceof` failed and 20 `statement-errors` tests went red) and check the pattern in `dist/worker/worker.js`**: the forced build cache served the previous glue once.
- That line was all the patch held from 2026-10-11 until #374 merged.

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
`yarn install`, then `CHROME_PATH=~/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome` (2026-10-30: the container had lost `~/.cache/ms-playwright`; `npx -y playwright@latest install chromium` from the scratchpad, Chrome for Testing 156; the old `chromium-1234/chrome-linux/chrome` is gone) `yarn
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
- **`TestContext.supportsJSPI()` tests `WebAssembly.Suspending`/`Suspender` since upstream #364
  (merged 2026-09-25)**; before it, it built a `WebAssembly.Function`, gone from Chrome 151, and every
  `jspi` describe was skipped. On a branch from current `master` the `jspi` tests run (checked
  2026-10-15: a new `vfs_handover` test failed on `jspi` as on the other two builds).
- **Upstream CI** (`.github/workflows/ci.yml`) runs `yarn test` on Chrome 129, then rebuilds the WASM
  with Emscripten 3.1.61 and runs it again. It starts on a PR from the fork without approval. Its
  job steps are readable through the public API (`/actions/runs/<id>/jobs`); its logs are not.
