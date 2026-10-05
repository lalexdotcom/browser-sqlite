# Stack, build and CI

## Versions

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Node 24.13, pnpm 10.31.0.
- Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat, no `esm/` level). Two
  entries, `index` and `worker`, with opposite goals — see below. `.d.ts` via `tsgo`.
- Lint/format: **biome 2.5.8** (`biome.json`; it locally disables `noExplicitAny` and
  `noBannedTypes`). Run `pnpm check` after every modification.
  - **biome covers `src/**`, `tests/**` and, since 2026-09-24, `scripts/**`** (`files.includes`) — `.mjs` and the bench page's `index.html` included.
  - **biome ignores `rslib.config.ts`.** Neither `pnpm format` nor `biome ci .` in CI will
    touch it, so a hand-edit's formatting survives untouched and nothing flags it. That
    file's style is maintained by hand — verified 2026-08-27 after a `},{` survived a
    format run.
- Tests: **rstest 0.11.8**, Playwright pinned at 1.62.1.
- **Runtime dependencies: none.** `wa-sqlite` is a devDependency only, vendored into
  `dist/worker/worker.js` at build time so it never reaches a consumer lockfile. **Pinned by commit
  SHA, not by tag, since 2026-09-15 (user):**
  `github:rhashimoto/wa-sqlite#7fcc30df39d0b1d8fe168351a870f2f912f991ee` since 2026-10-03, upstream
  `master` with our #363, #367, #368, #369 and #370 merged. #367, #368 and #370 were byte-identical to the
  heads the patch carried; #363 and #369 merged at later heads (`345791b3`, `87ed5aaf`) than the patch held,
  so that repin changed executed code in `OPFSAnyContextVFS.js` and `OPFSAdaptiveVFS.js`; `dist/` unchanged.
  Before that `7a4b4241` (2026-10-01, #351, #352, #353 merged and left the patch),
  `5be9cd14` (2026-09-29, #365 merged and left the patch), `e6e01ae1` (2026-09-28, our #350, #357 and #361 merged on 2026-09-27; #350 and
  #361 left the patch, #357 was never carried), `5e98ac76` (2026-09-26, #347, #348, #364), `e98c65de` (2026-09-23,
  #359) and `93b9230` (2026-09-21). Vendored, so a commit serves as well as a release and nothing waits for one.
  **The 2026-09-21 repin was taken for two fixes by other contributors**:
  #330, which stops a failed `sqlite3_open_v2` leaking the database handle SQLite allocates for it —
  `openWithRetry` can make 25 attempts, each of which leaked before — and #355, race conditions in
  `OPFSWriteAheadVFS`. The patch applied to the new base unchanged, only line offsets, and upstream's
  version is still `1.1.2`, so the `patchedDependencies` key did not move. **#330 also changes what a
  failed open reports** — SQLite's own `unable to open database file` instead of the function name
  (`mem:measurements`, WAL-COMPAT's neighbour in `mem:state`'s baseline; CHANGELOG under Changed).
  **`patches/wa-sqlite@1.1.2.patch` carries the upstream changes listed below, file by file**, and is
  no longer deletable as a block. Each is independent and each has a report in
  `docs/upstream/`, which is where the mechanisms and measurements live:
  - `IDBMirrorVFS.js` — #371 (a commit whose IndexedDB transaction aborts: commits built on it refused
    or dropped, the view reloaded from IndexedDB, `SQLITE_BUSY` at RESERVED, the journal of an aborted
    view removed on close), head `3367cb65` since 2026-10-03; and #372 (`jClose` waits for the commits in
    flight before closing the `BroadcastChannel`), head `69e00270` since 2026-10-03; and #374, `OPFSAdaptiveVFS.js`'s line 9 guarded (`FileSystemSyncAccessHandle?.prototype`), without which no worker loads outside a secure context (INSECURE-CONTEXT). The two PRs conflict
    in `jClose` only: the patch waits for the commits in flight first, then removes an aborted view's
    journal. Both PRs' tests pass on the merged file (226, 3/3, both engines).
  - `dist/wa-sqlite-jspi.mjs` — #375 (the `jspi` glue no longer wraps the synchronous relays in `WebAssembly.Suspending`), byte-identical to the PR's head `54c7eea3` since 2026-10-05. The glue is one minified line, so this hunk repeats it twice (~250 KB). **After any change to it, clear `node_modules/.cache/rspack` and check the pattern in `dist/worker/worker.js`**: the forced build cache served the previous glue once.
  - `IDBMirrorVFS.js`, that line and that glue are all the patch holds: every other PR it carried has merged.

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

### TS 7 in the editor — known, do not re-diagnose

TS 7 ships **no `lib/tsserver.js`**; the language service is the native binary driven over
LSP. VS Code's "Select TypeScript Version" therefore **cannot see the workspace version** —
by design, not a broken install. The editor is served by the `TypeScriptTeam.native-preview`
extension, wired in `.devcontainer/devcontainer.json` via two machine-scoped settings:
`"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "node_modules/typescript/lib"`.
The setting is `js/ts.tsdk.path`, **not** the `typescript.native-preview.tsdk` the write-ups
still document — trust VS Code's in-editor schema warning over the blog posts.

**Probing what the editor offers needs a TypeScript with the JS API, and the repo's has none.**
TS 7's `typescript` package exposes neither `createLanguageService` nor `sys`. The VS Code server
bundles the classic one for its built-in features —
`/vscode/vscode-server/bin/<commit>/extensions/node_modules/typescript/lib/typescript.js`, 6.0.3
and 5.9.3 on 2026-09-15 — and a script that requires it by path can call
`getCompletionsAtPosition`. That is how D10 of the statement-errors spec was measured. The repo's
own `tsc` still gives the diagnostics, as `tsc --ignoreConfig --noEmit --strict <file>`: without
`--ignoreConfig` it refuses a file argument while `tsconfig.json` exists (TS5112).

### A TS 7 trap paid for in wave 1

`const x: (() => T) | undefined = undefined` narrows to `undefined`, and TS 7 then reports
"Type 'never' has no call signatures" at `x?.()`. Writing
`undefined as (() => T) | undefined` preserves the union. Expect it again wherever a
placeholder `undefined` must keep a callable union type.

## Test suites

Four projects. `pnpm test` runs the first two.

**Both engines are installed locally** — `~/.cache/ms-playwright` carries chromium and firefox.
WebKit was absent on 2026-10-02; `playwright install webkit` downloads it but it cannot launch here
without system libraries (gstreamer, gtk4…) that need root. WebKit is not offered anywhere: the Linux build ships without OPFS, so every VFS
this library uses is missing there and the suite would report a platform gap as a failure.
**There is no engine environment variable any more (2026-09-03).** `TEST_BROWSER` and
`CONFORMANCE_BROWSER` are both gone: each suite has one config file per engine, and its
`pnpm` script chains them, so `pnpm test` and `pnpm test:conformance` each cover both engines
in one command and print TWO reports. Read both.

Why two files rather than two entries in one `projects` array: **rstest 0.11.8 refuses two
browser-enabled projects with different engines in a single run** — *"All browser-enabled
projects in one run must share provider/browser/headless/providerOptions"*. Verified; a
`projects` array holding both makes the command fail before it runs anything.

The variable that went was named `TEST_BROWSER` and **never `BROWSER`**: VS Code and
devcontainers already export the latter, pointing at a URL-opening helper, and Playwright then
failed with "Cannot read properties of undefined (reading 'launch')". Keep that in mind if an
engine switch is ever reintroduced.

| Project | Where | What |
|---|---|---|
| `unit` | `tests/unit/` (15 files) | Node, pure logic — bulk, capabilities, credits, debug, epochs, errors, exports, locks, logger, quoting, routing, scheduler, supervisor, transaction, utils |
| `chromium` | `tests/browser/*.test.ts` + `tests/browser/chromium/**` | Real Chromium via Playwright. `pnpm test:chromium`. `createTestClient(options?)` gives a unique OPFS name and an `afterEach` cleanup |
| `firefox` | the same shared files + `tests/browser/firefox/**` | `rstest.firefox.config.ts`, `pnpm test:firefox`. The shared glob is NON-recursive so neither project sees the other's directory. `firefox/` holds what cannot pass on Chromium — handle starvation; `chromium/` is declared and does not exist yet |
| `conformance` | `tests/conformance/` | On demand: every declared (vfs, build) pair through six invariants. `pnpm test:conformance` runs BOTH engines from two configs; no per-engine directory, deliberately — the value is the same invariants on both |
| `consumer` | `scripts/consumer-smoke.ts` | On demand: packs the tarball into **five** temp app dirs **outside** the repo and drives **dev and build for each** — Vite, Vite 6 (pinned), rsbuild, webpack, Parcel — plus no-bundler static serve and a bare-specifier assertion over `dist/**/*.js`. **24 stages.** `pnpm test:consumer` |

**Since 2026-09-15 each browser config declares one project PER TARGET, not one project.** A target is a
(vfs, build) pair, injected into the test code through `source.define` as `__BSQ_TEST_TARGET__`; a test
that names no VFS runs on it, and `tests/browser/target.ts`'s `resolvePair` falls back to another pair
when the test declares a `needs` the target cannot meet — **except under `BSQ_TEST_NEEDS=skip`, which
`pnpm test:matrix` sets on every cell since 2026-09-27: there the test is skipped**, since every pair a
fallback could reach is a cell of its own, and a fallback only reported its failures under another
pair's name (spec 2026-09-15, A7). rstest skips a running test only through its own `ctx.skip()`, so a
test that declares `needs` passes `skip` with them (`createTestClient({ needs, skip })`,
`pairFor(needs, skip)`); the types refuse one without the other. `pnpm test` therefore runs
`<engine> · OPFSWriteAheadVFS/sync` and `<engine> · OPFSAdaptiveVFS/async` per config —
**project filters must be globs** (`--project 'chromium*'`), rstest's filter being anchored.
`BSQ_TEST_TARGETS` overrides the list (`all`, or a comma list of `vfs/build`), and `pnpm test:matrix`
(`scripts/test-matrix.ts`) runs every declared pair on the three configs, bounding each run itself,
keeping raw reports under `.matrix/<run>/` and exiting non-zero on any failed or timed-out cell.

**Every browser script runs under a deadline since 2026-09-16** — `node scripts/bounded.ts
<seconds> <command>` wraps each leg of `test`, `test:browser`, `test:chromium`, `test:firefox`,
`test:isolated` and `test:conformance` (900 s per leg, 600 s for the isolated one), and exits 124
when it kills one, the code `test:matrix` already uses. It exists because a run CAN hang where
`testTimeout` and `hookTimeout` cannot reach — a module-scope `await` that never settles means no
test is running, so nothing times out (`mem:follow-ups`). `timeout(1)` is absent from a stock
macOS, hence a script rather than a shell word; `tests/unit/bounded.test.ts` proves the deadline
actually kills. **Since 2026-10-02 it kills the whole process group** (`detached`, then
`process.kill(-pid)`, and a `SIGKILL` to the group once the command exits): signalling the
direct child alone left `pnpm exec rstest`'s real pnpm, rstest and its browser running under
init. The command gets no stdin, since a background group that read the terminal would be
stopped; on Windows it falls back to the direct child. **It also keeps every run's output in `.test-runs/` (gitignored) since 2026-10-03, the newest 30, so a failure seen once survives a green rerun** (open-retry, `mem:follow-ups`); the command writes to a pipe as a result, as in CI, and `close` (or `exit` plus 2 s, should something it started hold the pipe) ends the wait. `BOUNDED_RUNS_DIR` moves the folder, for the script's own unit test.

**No test file enumerates VFS** since 2026-09-16: a file states what its subject needs of the pair
(`needs: ['two-workers' | 'interruptible' | 'shared-second-client']`) and the matrix supplies the
pairs. The five that used to sweep `ALL_VFS`/`SHARED_VFS` by hand repeated their whole sweep in
every cell.

350 tests green on `main`, 2026-08-26. **COOP/COEP live in ONE place: `rstest.isolated.config.ts`**,
which sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
require-corp` through a `modifyRsbuildConfig` plugin — a top-level `server.headers` key is silently
ignored by rstest. That config is chromium like the default one; the difference is the isolation,
not the engine, and it includes `tests/browser/isolated/**` only (7 tests per cell) because its
subject is the `sync` build's abort channel, which needs a `SharedArrayBuffer`. Every other config
stays un-isolated ON PURPOSE: that is what most consumers deploy, and the degraded path has to be
asserted somewhere. (This line used to say "no COOP/COEP headers anywhere" — true when the SAB was
removed, false since that config exists. Corrected 2026-09-16.)

Two rstest facts that cost time:

- **`rstest 0.11.8 has no `it.each`.** Parameterized tests use a plain `for` loop calling
  `it()` directly — see `tests/unit/routing.test.ts`.
- **`browserLogs: false`** in `rstest.config.ts`, so `console.log` from a browser test is
  invisible. Measurements must be surfaced through an assertion failure message. See
  `mem:lessons` for how to get a trace out of a test that never finishes.

`rstest.config.ts` runs **Chromium alone**; Chromium and Firefox are both installed by
`.devcontainer/post-create.sh` and by CI, so the matrix is possible but not enabled —
blocked on the two Firefox failures in `mem:follow-ups`. rstest accepts no provider but
`playwright`.

**Characterization-test convention.** A known bug is pinned with `it.fails(...)`: the test
asserts the *correct* behaviour and `.fails` asserts the bug is still there. When the bug
is fixed the test starts passing, which makes `it.fails` fail — **that red is the signal
to drop `.fails`, not a regression.** No `it.fails` anywhere since wave 2.

## Build output

```
dist/
  index.js          client-facing entry; keeps new URL('./worker/worker.js', …) literal
  *.d.ts            one per src module
  worker/
    worker.js             monolithic: 3 Emscripten glues + the VFS modules inlined
    wa-sqlite.wasm  wa-sqlite-async.wasm  wa-sqlite-jspi.wasm
```

**Both entries are minified and ship `.js.map` since 2026-08-27.** Sizes live in
`mem:measurements` and nowhere else. (The figure that stood here, "worker.js 117 KB gzip",
was stale even before minification — it measured 125.)

Only the VFS the consumer selects is fetched at runtime; the others are tarball weight
only. Source maps are never fetched unless devtools are open.

`dist/` also carries `LICENSE` beside `NOTICE`: `dist/NOTICE` says "see LICENSE", and
`dist/` is routinely separated from its package. Same reasoning as the inlined worker
banner — a pointer to a file that may not travel is no use.

**`package.json` declares `main` as well as `exports`.** Not redundant: Parcel's default
resolver does not read `exports` and falls back to `main`, so without it Parcel cannot
resolve the package at any version. The Parcel fixture in the consumer smoke is what stops
this field being deleted as dead weight.

### Build facts — not re-derivable without reading rslib source

**rslib's `esm` preset disables four parser behaviours unconditionally**
(`@rslib/core/dist/index.js:2880-2895`): `importMeta: false`, `importDynamic: false`,
`commonjs: { exports: 'skipInEsm' }`, `worker: false`; and adds `parser({ url: false })`
on the JS rule (`:2909`). This is deliberate — rslib contracts that a library entry leaves
`import.meta`, `import()`, `new Worker(new URL())` and `new URL()` intact for the
consumer's bundler. The `index` entry honours this; the `worker` entry overrides it.

**Why the worker entry uses `url: false`, not `true`:** `url: true` makes rspack emit the
wasm as content-hashed `asset/resource` files and rewrite
`new URL("wa-sqlite.wasm", import.meta.url)` into the webpack runtime expression
`__webpack_require__.p + "…"`, anchored by `__webpack_require__.b`. Neither Rollup (which
Vite uses for `format=iife` worker re-bundling) nor a consumer's own rspack can follow
that. With `url: false` the Emscripten glue keeps a literal, portable
`new URL("wa-sqlite.wasm", import.meta.url)`, and the three `.wasm` are placed beside
`worker.js` via `output.copy` — plain names, no content hash. Found through consumer smoke
testing, not by reading the docs.

**`distPath.wasm` (not `assets`) governs wasm output when `url: true`.** `output.assets`
and `output.webassemblyModuleFilename` have no effect on them. (Under `url: false` no
asset rule fires and `distPath.wasm` is irrelevant.)

**rslib forces the persistent build cache on** (`:2836`). Its digest tracks the config's
resolved *values* but not its *key structure*: changing `distPath.wasm: 'a'` to `'b'`
invalidates correctly, but swapping `distPath.assets` for `distPath.wasm` silently reuses
the old output. Fixed by `performance.buildCache.buildDependencies: [import.meta.filename]`
in `rslib.config.ts`, which hashes the config file itself. `pnpm build` is therefore always
correct; no manual `dist/` deletion is ever needed.

### Traps, each paid for once

- **`BannerPlugin`'s `stage`, once the output is minified.** Its default,
  `PROCESS_ASSETS_STAGE_ADDITIONS` (-100), runs *before* the minifier at `OPTIMIZE_SIZE`
  (400), so minification hoists declarations in front of the banner
  (`let e,t,r,…;/*! browser-sqlite …`). The notice still travels, but it is no longer the
  first bytes. The obvious fix is worse: a late stage such as `OPTIMIZE_INLINE` (700) puts
  the banner first **and silently breaks the source map**, because `DEV_TOOLING` (500) has
  already written it — the map then has no leading `;` for the banner's nine lines and
  every mapping is off by nine. The window is `OPTIMIZE_SIZE + 1`. **How to check:** the
  `mappings` field must open with as many `;` as the banner has lines.


- **Never put `/* webpackIgnore: true */` on the `new Worker(new URL(...))` call in
  `client.ts`.** rslib strips it from `dist/index.js` so it never reaches a consumer — but
  **rstest's own rspack honours it**, so no worker chunk is emitted at test time, the
  worker never loads, and the whole browser suite hangs forever with no error. The same
  applies to `/* @vite-ignore */`, which survives into `dist/` but only suppresses the
  `?worker_file` query, not the `import.meta.url` rewrite it was added to fight. Both were
  tried, both removed.
- **rsbuild has no `preview` config key** — only `server`, and `server.headers` **does**
  apply to `rsbuild preview`. Verified by probe. Vite is the one that splits `server` and
  `preview`; do not copy Vite's shape into an rsbuild config.
- **A chunked worker is impossible while Vite is a supported consumer.** Vite re-bundles
  worker entries through Rollup with `format=iife`, and Rollup refuses code-splitting in
  that format. Structural, not tuning. The monolithic worker is the permanent shipped
  shape — re-litigated and re-closed 2026-08-24.

**rsbuild renames the emitted worker chunk** (`webpackChunkName: "browser-sqlite"`), so no
test may assert a `worker/worker.js` substring in an error message. The lifecycle test
asserts the stable wording (`'could not load its worker from'`, `'Bundler Configuration'`)
instead.

### The consumer smoke's five fixtures — why each exists

`tests/consumer` (Vite), `tests/consumer-vite6`, `tests/consumer-rsbuild`,
`tests/consumer-webpack`, `tests/consumer-parcel`, plus `tests/consumer-nobundler`.

- **`consumer-vite6` is not redundant with `consumer`.** The latter's range resolves to the
  newest Vite, where `optimizeDeps.exclude` is a no-op — so the one line of configuration
  the README asks a consumer to write was verified by nothing. The pinned fixture is where
  that line decides whether dev works. **Falsified 2026-08-27**: delete the line and
  "Vite 6 dev server" reddens, alone.
- **`consumer-parcel` guards the `main` field** — the only resolver here that ignores
  `exports`.
- **`consumer-webpack` needs `scriptLoading: 'module'` on `HtmlWebpackPlugin`.** The output
  is ESM (`experiments.outputModule`), and the plugin's default `<script src>` has no
  `type="module"`, giving `Cannot use 'import.meta' outside a module` at runtime while the
  build passes.
- webpack and Parcel fixtures are **plain JS on purpose**: a TS loader is not what they are
  there to prove.
- `tsconfig.json` excludes them by prefix, `"tests/consumer*"`, not one by one — a new
  fixture must not redden `tsc --noEmit` for a resolution that is correct where it runs.
- `scaffoldApp` returns false rather than throwing: one bundler failing to install must not
  cancel the other four.

## Devcontainer

Ported from `lalexdotcom/claude-scaffold` on 2026-09-28 (identity, `gh`, lifecycle split), not
aligned with it wholesale: the image, the Playwright engines and the Serena prerelease flag are ours.

- **Agent tooling in `on-create.sh`, project setup in `post-create.sh`.** The Claude Code
  extension starts its MCPs and hooks when VS Code attaches, which is after `onCreateCommand`;
  `waitFor: "postCreateCommand"` holds the window until the project is set up.
- **Commit identity comes from `initializeCommand`, on the host.** VS Code copies the host
  `~/.gitconfig` into the container **once, at creation** — later starts only rewrite its
  `credential.helper` (seen 2026-09-28: a container built 2026-08-17 still held the host file of
  that date). The host file now carries no identity, sets `useConfigOnly`, and delegates through
  `includeIf "gitdir:~/Perso/Workspaces/"`, whose host path never matches in here. So
  `initializeCommand` resolves `user.name`, `user.email` and `credential.https://github.com.username`
  on the host and writes them to this clone's `.git/config`. Commits are `Alexandre LEGOUT`
  since then; the older `my-lalex` ones stay as they are.
- **`gh` gets no credential relay from VS Code; git does.** `post-attach.sh` asks
  `git credential fill` for that account's token and pipes it to `gh auth login --with-token`, at
  every attach, non-fatal.
- **`mempalace init` needs `--auto-mine`: `--yes` answers the entity questions only**, and init
  still asks "Mine this directory now?". During a rebuild stdin is a terminal, so the build waited
  on a prompt that `2>/dev/null` hid. `--no-llm`: there is no Ollama here.
- **There is no `serena index`, only `serena project index`.** The old line ran a missing command
  behind `2>/dev/null || true` and indexed nothing.

## CI and hooks

- `.github/workflows/ci.yaml` — two jobs on push to `main` and every PR; Chromium cached
  by `pnpm-lock.yaml` hash; `concurrency` cancels superseded runs.
  - `verify` — `biome ci` + `tsc --noEmit` + `pnpm build` + `pnpm test`. Blocking.
  - `consumer-smoke` — `pnpm test:consumer`, 11/11 stages. Blocking since wave P.
- `.github/workflows/release-and-publish.yaml` — on `v*` tags, build + publish, and it
  calls `pages.yaml` with `needs: release`.
- `.github/workflows/pages.yaml` — **the site is a pure function of two tags** since
  2026-09-03: `/` is the latest release tag, `/preview/` is the `preview` tag when one
  exists. **The ref that triggered a run is never built and never consulted**, so every
  trigger produces the same site and re-running anything is idempotent. Want a preview:
  `git tag -f preview && git push -f origin preview`. Want it gone: delete the tag.

  Triggers: `workflow_call` (from release-and-publish), `workflow_dispatch` (republish),
  push of `preview`, and `delete`. **`push` does NOT fire for a deleted ref** — `delete` is
  the event for that, it carries no ref filter, hence a job-level guard.

  **The root resolves `/releases/latest` FIRST and falls back to the list, and that order is
  load-bearing.** `latest` is the release GitHub designates and the one npm's `latest`
  dist-tag follows — which is what the page's badge claims the root to be. The list alone
  would put the root on the newest rc once a stable version exists, while
  `npm i browser-sqlite` still served the stable one, and the badge would be a lie.
  But **every release cut so far is a PRERELEASE and `latest` excludes those**, so it answers
  404 today: `gh release view` and `GET /releases/latest` both said "release not found", which
  is how the first preview run failed on 2026-09-03. Hence the fallback to
  `GET /releases?per_page=20`, newest first, drafts filtered out. The fallback stops being the
  live path the day a stable version ships.

  **`gh api` writes the response BODY to stdout when it fails**, and `--jq` does not filter
  it. So `VAR=$(gh api … || true)` captures `{"message":"Not Found",…}` as if it were data —
  it passed every emptiness test and died three steps later in `actions/checkout` with
  `fatal: invalid refspec '+refs/heads/{"message":"Not Found"…'`. **Gate on the exit status**
  — `if VAR=$(gh api …); then` — and shape-check anything that reaches a checkout.

  What bites, all of it silent:
  - **Order.** `assemble.ts` opens with `rmSync(target, …)`, so the root must be assembled
    BEFORE the preview that sits inside it. The reverse deletes the preview.
  - **The root's ASSEMBLER is copied in from the triggering checkout; only its content comes
    from the release tag.** Otherwise the step runs the released tag's own assembler,
    frozen at whatever shipped, which predates the flags and falls back to the environment —
    and the environment names the TRIGGER. On 2026-09-03 that made the root label itself
    `preview`; harmless only because the badge does not print the ref when `IS_RELEASE` is
    true, and a lie the moment a `delete` run sets REF_TYPE to `branch` and the real release
    shows "development build". The copy degrades to a no-op once a release ships a script
    that takes the flags.
  - **The preview step runs the preview tree's OWN assembler, and its name depends on the tag**: `assemble.mjs` before 2026-10-03, `assemble.ts` since. The step takes whichever exists; hard-coding one name fails on a preview tag from the other side of the rename.
  - **The build label is passed to `assemble.ts` as an ARGUMENT — `--ref` and `--release` —
    never through the environment.** Actions reposes the `GITHUB_*` variables for every step
    and IGNORES a step-level `env:` that tries to override them, so a run building a ref
    other than its trigger cannot describe itself that way. Overriding them was tried and
    shipped on 2026-09-03: both halves came out labelled with the triggering tag and BOTH
    claimed to be the published package, `/preview/` included. The preview passes no
    `--release`, which is the point — `preview` IS a tag, and without an explicit label the
    script takes any tag for a release tag.
  - **A `delete` run executes from the DEFAULT BRANCH**, so its deployment presents
    `refs/heads/main`. An environment restricted to tags refuses it, and a deleted tag then
    leaves its preview up until the next release. `main` must stay allowed for deletion to
    work.

  **Which workflow FILE runs differs by trigger**, and it bites once: a `push` runs the file
  as it exists at the pushed commit, so tagging a commit that predates a change to this file
  fires nothing. `delete` reads the default branch; `workflow_call` runs at the caller's ref.
  There is no `workflow_dispatch` — removed on the user's instruction, 2026-09-03, since
  re-pushing the tag unchanged is already the republish.

  **The `github-pages` environment allows `main`, the `v*` tags and the `preview` tag**
  (user, 2026-09-03). `main` is there for one reason and it is not obvious: `delete` runs
  from the default branch, so without it a deleted `preview` tag could not take its preview
  down. `feat/*` was dropped — no branch deploys any more.
- Local hooks (simple-git-hooks), three since 2026-09-11: `pre-commit` runs `tsc`,
  `lint-staged` and the unit project (~1.5 s), or `pnpm test` while concluding a conflicted
  merge; `pre-merge-commit` runs `tsc`, `biome ci .` and `pnpm test`; `pre-push` the same, plus since
  2026-09-15 CI's VFS table check (`pnpm docs:vfs && git diff --exit-code VFS.md`), before the
  suite so a stale table fails fast. The render rewrites `VFS.md`'s generated spans in the working
  tree, so an UNCOMMITTED hand edit inside one is overwritten silently by a push. All
  bypassable with `--no-verify`. The agent's own verification at delivery is the gate (user),
  CI the independent one. Details: `mem:git-hooks`.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath`. Without it the root tsconfig pushes the common
  source root to the repo root: declarations would land in `dist/src/` while
  `package.json` points at `dist/index.d.ts`, and `dist/tests/` would ship inside the
  package.
- `tsconfig.json` `include` is `["src", "tests", "scripts", "rslib.config.ts", "rstest.config.ts"]` — `scripts` since 2026-09-24. **`.mjs` files are still not type-checked**: there is no `allowJs`/`checkJs` (`mem:follow-ups`).
  Only `strict` is on.

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
suite (Firefox included), a Playwright `launchPersistentContext` script serving `.work/` works —
`.scratchpad/365-lib-arms/reopen-runner.mjs`.

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

## The benchmark page

`scripts/bench/html/index.html`, one self-contained file served beside a **verbatim** copy
of `dist/`, so it exercises the library exactly as a bundler-free consumer would. Scripts:
`scripts/bench/{assemble,check,dev}.mjs`. `pnpm bench:dev` / `bench:serve` / `bench:build`.
`http://127.0.0.1` is a secure context, so OPFS works with no certificate. A phone on the
LAN is not, so a tunnel is needed there. `.bench/` holds device exports and is gitignored —
read, never committed.

The page's layout under `scripts/bench/` was the user's call over a reasoned objection.
Do not relitigate it.
