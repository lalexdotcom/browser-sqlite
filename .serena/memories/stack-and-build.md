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
- Tests: **Vitest 5.0.3** with `@vitest/browser-webdriverio` 5.0.0 and webdriverio 10.0.2 on stock Chrome 153 and Firefox 155, pinned in `scripts/browsers.ts` (§ Test suites). Playwright and rstest are gone since 2026-10-10. Stock Firefox is the one users run; Playwright's was ~5× slower on nested `await`s (FF-PW-AWAIT, `mem:measurements/footprint`).
- **Runtime dependencies: none.** `wa-sqlite` is a devDependency only, vendored into
  `dist/worker/worker.js` at build time and pinned by commit SHA: the pin, the patch and how to
  regenerate it, and the fork's test suite are in `mem:stack-and-build/wa-sqlite`.

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

**Vitest 5.0.3 with `@vitest/browser-webdriverio` 5.0.0 and webdriverio 10.0.2, on stock Chrome for Testing and Firefox, since 2026-10-10** (rstest and Playwright left the repository). The decisions are the user's and live in `docs/superpowers/specs/2026-10-10-vitest-webdriverio-design.md` (D1-D11); their principles are in `mem:conventions` (§ Testing in browsers). What follows is what the code will not tell you.

**The browsers are pinned in `scripts/browsers.ts`** (`PINNED`: Chrome `153.0.8010.52`, Firefox `stable_155.0.1`), read by `vitest.config.ts`, `scripts/consumer-smoke.ts` and `scripts/bench/check.ts`; `BSQ_CHROME_VERSION` and `BSQ_FIREFOX_VERSION` override them (an empty value falls back to the pin). geckodriver is pinned there too (`GECKODRIVER_VERSION`, `0.37.1`, via `wdio:geckodriverOptions`), so the cache key describes what the cache holds. A Firefox version needs its channel prefix: `@puppeteer/browsers` reads a bare number or `latest` as a Nightly, so `browsers.ts` refuses one without. WebdriverIO downloads browsers and drivers into `node_modules/.cache/wdio`. `node scripts/browsers.ts install` downloads both and opens a session in each (it prints two `ok`); `node scripts/browsers.ts deps` lists the apt packages both need. `.devcontainer/post-create.sh` runs the two at creation; CI caches the folder, keyed on `scripts/browsers.ts`, and runs `install` before any test (§ CI and hooks). **webdriverio must stay on 10.x**: 9.x's `@puppeteer/browsers` 2.x fetches an x86-64 Chrome on linux-arm64, where 3.x maps `linux_arm` to `linux-arm64` from Chrome 153.0.8001.0. Safari, Windows and macOS are the next piece of work (spec § 8); WebKit is in no config (Playwright's Linux WebKit is no stand-in for Safari, `mem:conventions`).

**The tests run the library as rslib builds it.** `rslib.test.config.ts` imports `rslib.config.ts` untouched, moves every `distPath` to `tests/build/` (gitignored) and adds a second `lib` item for `tests/testing.ts` (the public surface plus the internals the white-box tests drive), so `testing.js` sits beside `index.js` and the worker under test is the shipped `worker/worker.js`. `vitest.config.ts` aliases `browser-sqlite` to `tests/build/index.js` and `browser-sqlite/testing` to `tests/build/testing.js`; `tsconfig.json` maps the same names to the sources through `paths`, so the types need no build. `tests/testing.ts` lives outside `src/` because `tsconfig.build.json` would emit it as `dist/testing.d.ts`. Every browser project declares `globalSetup: tests/build-setup.ts`, which runs the build once per Vitest invocation (~9 s cold) in its own persistent cache, `node_modules/.cache/rspack-test`, so any command that touches a browser tests the current tree. **A test imports from ONE bundle**: two bundles are two copies of the code, and `instanceof` and module singletons do not cross. The unit project runs on `src/` with no build.

| Project | Where | What |
|---|---|---|
| `unit` | `tests/unit/` | Node, pure logic and the tooling scripts' own tests |
| `chrome · <vfs>/<build>` | `tests/browser/*.test.ts` + `tests/browser/chromium/**` | Stock Chrome. `createTestClient(options?)` gives a unique OPFS name and an `onTestFinished` cleanup |
| `firefox · <vfs>/<build>` | the same shared files + `tests/browser/firefox/**` | Stock Firefox. The shared glob is NON-recursive so neither project sees the other's directory. `firefox/` holds what cannot pass on Chrome — handle starvation, stream retention; `chromium/` is declared and does not exist yet |
| `isolated chrome · …`, `isolated firefox · …` | `tests/browser/isolated/**` | The same browsers with COOP/COEP |
| `conformance chrome`, `conformance firefox` | `tests/conformance/` | Every declared (vfs, build) pair through six invariants; no target and no per-engine directory, deliberately — the value is the same invariants on both engines |
| `consumer` | `scripts/consumer-smoke.ts` | On demand, `pnpm test:consumer`: packs the tarball into temp app dirs **outside** the repo and drives dev and build for each — Vite, Vite 6 (pinned), rsbuild, webpack, Parcel — plus no-bundler static serve and a bare-specifier assertion over `dist/**/*.js`, with stock Chrome through WebdriverIO. Its console, page-error and failed-request listeners are WebDriver BiDi events |

**One `vitest.config.ts`, one project per target.** A target is a (vfs, build) pair, handed to the tests through Vitest's `provide` / `inject` (`bsqTarget`, `bsqNeeds`); a test that names no VFS runs on it, and `tests/browser/target.ts`'s `resolvePair` falls back to another pair when the test declares a `needs` the target cannot meet — **except under `BSQ_TEST_NEEDS=skip`, which `pnpm test:matrix` sets on every cell: there the test is skipped**, since every pair a fallback could reach is a cell of its own, and a fallback only reported its failures under another pair's name (spec 2026-09-15, A7). A test that declares `needs` passes `skip` with them (`createTestClient({ needs, skip })`, `pairFor(needs, skip)`); the types refuse one without the other. `pnpm test` therefore runs `<engine> · OPFSWriteAheadVFS/sync` and the engine's other recommended pair per engine. **Project filters must be globs** (`--project 'chrome ·*'`). `BSQ_TEST_TARGETS` overrides the list (`all`, or a comma list of `vfs/build`). Each browser project builds its own `instances` array: Vitest renames an instance in place, and two projects sharing one fail at startup.

**Commands.** Every vitest script carries `--configLoader runner`: the default loader prints Vite's `configLoader: 'native'` warning (extensionless imports in `src/`, reached through `tests/target-projects.ts`) eleven times per run. `pnpm test` is ONE run (`unit`, `chrome`, `firefox` and `isolated`) through `scripts/test-parallel.ts`, bounded at 2400 s — one merged report to read, and a red Chrome no longer silences Firefox behind an `&&`. `pnpm test:conformance` covers both engines the same way; `:chrome` and `:firefox` run one. All of them are `node scripts/bounded.ts <s> node scripts/test-parallel.ts --project <glob>…`; extra arguments after `--` go to the merge (`pnpm test -- --reporter=json --outputFile=<f>`). `pnpm test:matrix` (`scripts/test-matrix.ts`) runs every declared pair on four columns — `chrome`, `firefox`, `isolated-chrome`, `isolated-firefox` — as one `vitest run` per cell, `BSQ_TEST_JOBS` cells at a time through the same pool, with `BSQ_TEST_TARGETS=<pair>` and `BSQ_TEST_NEEDS=skip`, bounded at 600 s by the script itself, keeping Vitest's JSON report and the console per cell in a timestamped directory of the matrix's own (gitignored) and exiting non-zero on any failed or timed-out cell. Vitest's JSON reporter carries no project name: a cell is one project run alone. `abandon-gc.test.ts` needs V8's `gc`: `BSQ_EXPOSE_GC=1` adds `--js-flags=--expose-gc` to Chrome, and without it the file skips.

**Provider facts that cost time (2026-10-10).**
- **The WebdriverIO provider runs the files of a project one at a time** (`supportsParallelism = false`) where rstest ran them in parallel pages: one Vitest invocation cannot use the machine, and projects run one after another in it. Parallelism is therefore several Vitest PROCESSES (next bullet); the figures are in `mem:measurements/suite-and-matrix`, PARALLEL-RUNS.
- **Parallel runs: `scripts/test-parallel.ts` (user-approved 2026-10-10).** `node scripts/test-parallel.ts --project <glob>… [-- <args for the merge>]` resolves the globs (Vitest's `*`, whole name, any case) against `vitest list --filesOnly --json`, builds `tests/build/` ONCE and gives every child `BSQ_TEST_BUILT=1` (each browser project's globalSetup builds it otherwise, and N builds race on the directory), then runs `vitest run --project <name> [--shard=i/N] --reporter=blob` as a pool of processes: `BSQ_TEST_JOBS` (a positive integer, else an error) or `min(12, CPUs - 1)`, at least 1 — 12 here, 3 on a 4-vCPU runner. Each browser project gets `max(1, min(files, round(jobs × files / browser files)))` shards; `unit` is one job. Each job is bounded at 900 s (`runBounded`, kills the process group; shared with the matrix in `scripts/parallel.ts`), logs to `<run>/logs/`, and writes its blob to `<run>/blobs/` — **a directory of its own: `--merge-reports` reads every file in it**. `vitest --merge-reports <run>/blobs --reporter=default` then gives ONE report, identical test by test to an unsharded run. A job that ends without its blob (crash, kill, timeout) fails the launcher, which names it with the last 60 lines of its log; the merged report lacks its tests, so never read the merge alone. Each process has its own WebDriver session, hence its own browser profile and port, so the per-file storage wipe never reaches another process. Each run has a timestamped directory of the launcher's own (gitignored, newest 10 kept) holding `blobs/` and `logs/`. A Node script cannot import `tests/target-projects.ts` (extensionless imports in `src/`): project names come from `vitest list`. Ctrl-C and a CI cancellation kill the jobs' groups (they are detached, so `bounded.ts`'s group kill alone would not).
- **Storage is shared across the files of a PROJECT** (one browser profile per project: each project is its own WebDriver session, and projects run one after another, so the wipe never reaches another project's storage; the shards of a parallel run are separate processes, so separate profiles too), where rstest gave each file a fresh context. `AccessHandlePoolVFS` has six fixed OPFS slots, freed only by `xDelete`, so a test that only closed its database exhausted them for the files after it ("unable to open database file"). **Every browser project therefore registers `tests/storage-wipe.ts` as a setup file (user, 2026-10-10: "un clean efficace et vérifié à la fin de chaque VFS+build")**: after each test file's own cleanups its `afterAll` removes every OPFS root entry and every IndexedDB database, then checks that OPFS is empty and `indexedDB.databases()` is empty. A handle still held, or a database still open, fails THAT file with the entry's name (after a 3 s settle, for a worker that has just closed). Falsified with a scratch file that leaked an open `createWritable()` and an open IndexedDB connection: red on Chrome and Firefox. A failure that appears in a full run and not in its file alone is read with this first.
- **`onTestFinished` hooks run in reverse under Vitest.** A test that intercepts workers registers its restore before `createTestClient`'s cleanup, so the cleanup ran first, with the test's broken `Worker`; `deleteDatabase` on `AccessHandlePoolVFS` spawns a worker, failed, and left the slots taken. The cleanup now deletes through the browser's own `Worker` (`withNativeWorker`, `tests/browser/helpers.ts`).
- **`screenshotFailures: false`**: on BiDi the provider cannot switch frames, and every failure printed a stack trace for the screenshot it tried.
- `realm.test.ts` and `cross-tab.test.ts` create their own iframe inside Vitest's.

**Every browser script runs under a deadline since 2026-09-16** — `node scripts/bounded.ts <seconds> <command>` wraps `test`, `test:browser`, `test:chrome`, `test:firefox`, `test:isolated` and the conformance scripts, and exits 124 when it kills one, the code `test:matrix` already uses. It exists because a run CAN hang where `testTimeout` and `hookTimeout` cannot reach (`mem:follow-ups`). `timeout(1)` is absent from a stock macOS, hence a script rather than a shell word; `tests/unit/bounded.test.ts` proves the deadline actually kills. **Since 2026-10-02 it kills the whole process group** (`detached`, then `process.kill(-pid)`, and a `SIGKILL` to the group once the command exits): signalling the direct child alone left `pnpm exec <runner>`'s real pnpm, the runner and its browser running under init. The command gets no stdin, since a background group that read the terminal would be stopped; on Windows it falls back to the direct child. **It also keeps every run's output in `.test-runs/` (gitignored), the newest 30, so a failure seen once survives a green rerun** (open-retry, `mem:follow-ups`); the command writes to a pipe as a result, as in CI, and `close` (or `exit` plus 2 s, should something it started hold the pipe) ends the wait. `BOUNDED_RUNS_DIR` moves the folder, for the script's own unit test.

**No test file enumerates VFS** since 2026-09-16: a file states what its subject needs of the pair (`needs: ['two-workers' | 'interruptible' | 'shared-second-client']`) and the matrix supplies the pairs.

**COOP/COEP live in ONE place: the `isolated` projects of `vitest.config.ts`**, through `server.headers` (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). They include `tests/browser/isolated/**` only, because their subject is the `sync` build's abort channel, which needs a `SharedArrayBuffer`, and they run on Chrome and Firefox (spec D8). Every other project stays un-isolated ON PURPOSE: that is what most consumers deploy, and the degraded path has to be asserted somewhere.

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
  **rstest's own rspack honoured it** (the tests now run the rslib build): no worker chunk
  was emitted at test time, the worker never loaded, and the suite hung forever with no
  error. The same
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
aligned with it wholesale: the image, the stock browsers (`post-create.sh` installs their system libraries, then the pinned browsers) and the Serena prerelease flag are ours.

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
  every attach, non-fatal. Logged in as `lalexdotcom` since 2026-09-28 (scopes `repo`, `read:org`,
  `workflow`, `gist`, `user`). Anything outward-facing through `gh` — a fork, a comment, a PR —
  waits for the user's go. **`gh` cannot re-request a review upstream** (2026-09-30):
  `requested_reviewers` answers 404 and `gh pr edit --add-reviewer` is refused for lack of
  permission, so that click is the user's.
- **`mempalace init` needs `--auto-mine`: `--yes` answers the entity questions only**, and init
  still asks "Mine this directory now?". During a rebuild stdin is a terminal, so the build waited
  on a prompt that `2>/dev/null` hid. `--no-llm`: there is no Ollama here.
- **There is no `serena index`, only `serena project index`.** The old line ran a missing command
  behind `2>/dev/null || true` and indexed nothing.

## CI and hooks

- `.github/workflows/ci.yaml` — two jobs on push to `main` and every PR; WebdriverIO's browsers
  cached by the hash of `scripts/browsers.ts`; `concurrency` cancels superseded runs. **Every job that
  drives a browser (`verify`, `consumer-smoke`, the release `cells`) runs two steps after the cache
  (2026-10-11):** `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` — the runner has
  it at 1, and Chrome for Testing, having no AppArmor profile, then exits at launch ("Chrome instance
  exited"); lifting it keeps the sandbox, `--no-sandbox` would drop it — and `node scripts/browsers.ts
  install`, so the browsers and drivers download once, before `test-parallel` starts jobs that would
  race on a cold cache (chromedriver spawned before it was executable, `EACCES`). First green run on
  the WebdriverIO suite: PR #7, run 38182346151.
  - `verify` — `biome ci` + `tsc --noEmit` + `pnpm build` + `pnpm test`. Blocking.
  - `consumer-smoke` — `pnpm test:consumer`. Blocking since wave P.
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
  - **A run that publishes nothing could cancel one that does, and did.** `cancel-in-progress` on
    a shared group, `concurrency` evaluated before any job runs, and `delete` with no ref filter:
    deleting a merged branch on 2026-09-04 killed the preview deploy pushed two seconds earlier,
    then skipped itself, leaving the site on the previous build with nothing to say so. Fixed by
    repeating the job's guard in the group expression, so a skipping run gets
    `pages-noop-<run_id>` and contends with nobody. **The two conditions must stay identical;
    `concurrency` cannot read `env`.** The expression was verified valid on GitHub; the
    cancellation itself was never staged.

  **Which workflow FILE runs differs by trigger**, and it bites once: a `push` runs the file
  as it exists at the pushed commit, so tagging a commit that predates a change to this file
  fires nothing. `delete` reads the default branch; `workflow_call` runs at the caller's ref.
  There is no `workflow_dispatch` — removed on the user's instruction, 2026-09-03.
  **Re-pushing the tag UNCHANGED does nothing** — git answers `Everything up-to-date` and emits no
  event, so no run starts (believed otherwise until 2026-09-04). To republish without moving it:
  `git push origin --delete preview && git push origin preview`, which briefly takes the preview down.

  **The `github-pages` environment allows `main`, the `v*` tags and the `preview` tag**
  (user, 2026-09-03). `main` is there for one reason and it is not obvious: `delete` runs
  from the default branch, so without it a deleted `preview` tag could not take its preview
  down. `feat/*` was dropped — no branch deploys any more. Putting unmerged work on a real
  device through the `preview` tag is an exposure kept deliberately (user, 2026-08-26), which is
  what makes the page's "development build" banner and `buildRef()` in
  `scripts/bench/assemble.ts` load-bearing.
- Local hooks (simple-git-hooks), three since 2026-09-11: `pre-commit` runs `tsc`,
  `lint-staged` and the unit project (~1.5 s), or `pnpm test` while concluding a conflicted
  merge; `pre-merge-commit` runs `tsc`, `biome ci .` and `pnpm test`; `pre-push` runs those three too, plus since
  2026-09-15 CI's VFS table check (`pnpm docs:vfs && git diff --exit-code VFS.md README.md`, README since 2026-10-06), before the
  suite so a stale table fails fast. Since 2026-10-05 the two merge paths (`pre-merge-commit`, and `pre-commit` concluding a conflicted merge) first run `pnpm install --frozen-lockfile` when the merge changes the dependencies (`mem:git-hooks`). The render rewrites `VFS.md`'s generated spans in the working
  tree, so an UNCOMMITTED hand edit inside one is overwritten silently by a push. All
  bypassable with `--no-verify`. The agent's own verification at delivery is the gate (user),
  CI the independent one. Details: `mem:git-hooks`.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath`. Without it the root tsconfig pushes the common
  source root to the repo root: declarations would land in `dist/src/` while
  `package.json` points at `dist/index.d.ts`, and `dist/tests/` would ship inside the
  package.
- `tsconfig.json` `include` is `["src", "tests", "scripts", "rslib.config.ts", "vitest.config.ts", "rslib.test.config.ts"]` — `scripts` since 2026-09-24. **`.mjs` files are still not type-checked**: there is no `allowJs`/`checkJs` (`mem:follow-ups`).
  Only `strict` is on.

## The benchmark page

`scripts/bench/html/index.html`, one self-contained file served beside a **verbatim** copy
of `dist/`, so it exercises the library exactly as a bundler-free consumer would. Scripts:
`scripts/bench/{assemble,check,dev}.mjs`. `pnpm bench:dev` / `bench:serve` / `bench:build`.
`http://127.0.0.1` is a secure context, so OPFS works with no certificate. A phone on the
LAN is not, so a tunnel is needed there. `.bench/` holds device exports and is gitignored —
read, never committed.

The page's layout under `scripts/bench/` was the user's call over a reasoned objection.
Do not relitigate it.
