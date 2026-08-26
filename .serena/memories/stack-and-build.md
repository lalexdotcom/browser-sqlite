# Stack, build and CI

## Versions

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Node 24.13, pnpm 10.31.0.
- Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat, no `esm/` level). Two
  entries, `index` and `worker`, with opposite goals — see below. `.d.ts` via `tsgo`.
- Lint/format: **biome 2.5.8** (`biome.json`; it locally disables `noExplicitAny` and
  `noBannedTypes`). Run `pnpm check` after every modification.
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

| Project | Where | What |
|---|---|---|
| `unit` | `tests/unit/` (15 files) | Node, pure logic — bulk, capabilities, credits, debug, epochs, errors, exports, locks, logger, quoting, routing, scheduler, supervisor, transaction, utils |
| `browser` | `tests/browser/` (15 files + `helpers.ts`) | Real Chromium via Playwright. `createTestClient(options?)` gives a unique OPFS name and an `afterEach` cleanup |
| `conformance` | `tests/conformance/` | On demand: every declared (vfs, build) pair through six invariants. `pnpm test:conformance` |
| `consumer` | `scripts/consumer-smoke.mjs` | On demand: packs the tarball into two temp app dirs **outside** the repo and drives four modes — Vite dev, Vite build+preview, rsbuild preview, no-bundler static serve. Plus a static bare-specifier assertion over `dist/**/*.js`. `pnpm test:consumer` |

308 tests green on `main`, 2026-08-24. **No COOP/COEP headers anywhere** since the SAB was
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

Sizes (wa-sqlite v1.1.2, gzip): `worker.js` 117 KB, `index.js` 4 KB, the three `.wasm`
2.4 MB raw combined. Only the VFS the consumer selects is fetched at runtime; the others
are tarball weight only.

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

### Three traps, each paid for once

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

## CI and hooks

- `.github/workflows/ci.yaml` — two jobs on push to `main` and every PR; Chromium cached
  by `pnpm-lock.yaml` hash; `concurrency` cancels superseded runs.
  - `verify` — `biome ci` + `tsc --noEmit` + `pnpm build` + `pnpm test`. Blocking.
  - `consumer-smoke` — `pnpm test:consumer`, 11/11 stages. Blocking since wave P.
- `.github/workflows/release-and-publish.yaml` — on `v*` tags, build + publish, and it
  calls `pages.yaml` with `needs: release`.
- `.github/workflows/pages.yaml` — `workflow_call` + `workflow_dispatch`. Publishing is
  release-only by design; the `github-pages` environment allows `main`, `v*` and `feat/*`.
  **A reusable workflow runs at the caller's ref**, which is what builds the tag. The
  `workflow_dispatch` trigger is only offered for workflows present on the default branch —
  that cost an hour to discover.
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
