# Stack, build and CI

## Versions

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Node 24.13, pnpm 10.31.0.
- Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat, no `esm/` level). Two
  entries, `index` and `worker`, with opposite goals — see below. `.d.ts` via `tsgo`.
- Lint/format: **biome 2.5.8** (`biome.json`; it locally disables `noExplicitAny` and
  `noBannedTypes`). Run `pnpm check` after every modification.
  - **biome ignores `rslib.config.ts`.** Neither `pnpm format` nor `biome ci .` in CI will
    touch it, so a hand-edit's formatting survives untouched and nothing flags it. That
    file's style is maintained by hand — verified 2026-08-27 after a `},{` survived a
    format run.
- Tests: **rstest 0.11.8**, Playwright pinned at 1.62.1.
- **Runtime dependencies: none.** `wa-sqlite` is a devDependency only
  (`github:rhashimoto/wa-sqlite#v1.1.2`, commit `2bf1c59`), vendored into
  `dist/worker/worker.js` at build time so it never reaches a consumer lockfile.
  `patches/wa-sqlite@1.1.1.patch` carries the WebKit `OPFSAnyContextVFS` fix.
  - **The `wa-sqlite` on npmjs is not the upstream package**: `1.0.0`, published by
    `gabrieldevunstatic <tailinh@unstatic.co>`, no `repository` field. Never point at it.
  - The v1.1.2 tag ships a `package.json` still saying `"version": "1.1.1"` — upstream
    forgot the bump. Verify by commit, not by that field.

### TS 7 in the editor — known, do not re-diagnose

TS 7 ships **no `lib/tsserver.js`**; the language service is the native binary driven over
LSP. VS Code's "Select TypeScript Version" therefore **cannot see the workspace version** —
by design, not a broken install. The editor is served by the `TypeScriptTeam.native-preview`
extension, wired in `.devcontainer/devcontainer.json` via two machine-scoped settings:
`"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "node_modules/typescript/lib"`.
The setting is `js/ts.tsdk.path`, **not** the `typescript.native-preview.tsdk` the write-ups
still document — trust VS Code's in-editor schema warning over the blog posts.

### A TS 7 trap paid for in wave 1

`const x: (() => T) | undefined = undefined` narrows to `undefined`, and TS 7 then reports
"Type 'never' has no call signatures" at `x?.()`. Writing
`undefined as (() => T) | undefined` preserves the union. Expect it again wherever a
placeholder `undefined` must keep a callable union type.

## Test suites

Four projects. `pnpm test` runs the first two.

**Both engines are installed locally** — `~/.cache/ms-playwright` carries chromium, firefox
and webkit. WebKit is not offered anywhere: the Linux build ships without OPFS, so every VFS
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
| `consumer` | `scripts/consumer-smoke.mjs` | On demand: packs the tarball into **five** temp app dirs **outside** the repo and drives **dev and build for each** — Vite, Vite 6 (pinned), rsbuild, webpack, Parcel — plus no-bundler static serve and a bare-specifier assertion over `dist/**/*.js`. **24 stages.** `pnpm test:consumer` |

350 tests green on `main`, 2026-08-26. **No COOP/COEP headers anywhere** since the SAB was
removed — if you find a reference to them in a config, it is stale.

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

  Three things bite, all of them silent:
  - **Order.** `assemble.mjs` opens with `rmSync(target, …)`, so the root must be assembled
    BEFORE the preview that sits inside it. The reverse deletes the preview.
  - **`GITHUB_REF_NAME` / `REF_TYPE` / `SHA` are overridden on both build steps.**
    `assemble.mjs` reads them to label the page, and the runner's values describe the
    TRIGGERING ref, which is never what is being built. Unset, the root would call a genuine
    release a "development build", and the preview would print a commit it did not measure.
    `REF_TYPE` is forced to `branch` for the preview because `preview` IS a tag and the
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
- Local `pre-commit` (simple-git-hooks): `lint-staged` + `pnpm test` + `tsc --noEmit`.
  Heavy and bypassable with `--no-verify`; CI is the real gate.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath`. Without it the root tsconfig pushes the common
  source root to the repo root: declarations would land in `dist/src/` while
  `package.json` points at `dist/index.d.ts`, and `dist/tests/` would ship inside the
  package.
- `tsconfig.json` `include` is `["src", "tests", "rslib.config.ts", "rstest.config.ts"]`.
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
