# Project State — `browser-sqlite`

Snapshot date: 2026-08-17. Update this file when the facts below change.

## What it is

`browser-sqlite` v1.0.0-rc.3 — persistent SQLite in the browser: wa-sqlite (WASM) +
a Web Worker pool + OPFS/IndexedDB VFS. Concurrency model: **concurrent reads across
the pool, writes serialized through one designated writer worker**. That model is
sound and is the thing worth preserving; see `mem:follow-ups` for what is broken in
its implementation.

## Stack

Versions below are post-upgrade (2026-08-17) and verified green: `tsc --noEmit`,
`biome check`, `pnpm build`, 105 tests (57 unit + 48 browser) — all pass.

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat,
  no `esm/` level); two explicit entries — `index` and `worker` — each with opposite
  goals (see "Build facts" below). Generated `.d.ts` via `tsgo`. Node 24.13.
- Lint/format: **biome** 2.5.8 (`biome.json`; note it locally disables `noExplicitAny`
  and `noBannedTypes`). Run `pnpm check` after every modification.
- Tests: **rstest 0.11.8** with two projects (`rstest.config.ts`):
  - `unit` — Node, pure logic → `tests/unit/{debug,orchestrator,utils}.test.ts`
  - `browser` — real Chromium via Playwright →
    `tests/browser/{init,queries,concurrency,transaction,bulk-write,output,vfs}.test.ts`
    plus `helpers.ts` (`createTestClient(options?)` — unique OPFS name + afterEach cleanup).
    Needs COOP/COEP headers, injected by an inline rsbuild plugin.
    105 tests total as of wave 0.
- Package manager: pnpm 10.31.0. Playwright pinned at 1.62.1 (Chromium 1234 in the
  container's `~/.cache/ms-playwright`, installed by `.devcontainer/post-create.sh`).

### TS 7 in the editor — known, do not re-diagnose

TS 7 ships **no `lib/tsserver.js`** (`node_modules/typescript/lib/` holds only
`getExePath.js`, `tsc.js`, `version.cjs`); the language service is the native binary driven
over LSP. So VS Code's "TypeScript: Select TypeScript Version" **cannot see the workspace
version** — by design, not a broken install. The editor is served by the
`TypeScriptTeam.native-preview` extension instead, wired in
`.devcontainer/devcontainer.json` via two machine-scoped settings:
`"js/ts.experimental.useTsgo": true` and `"js/ts.tsdk.path": "node_modules/typescript/lib"`.
Gotcha: the setting is `js/ts.tsdk.path`, **not** the `typescript.native-preview.tsdk` that
the write-ups still document — trust VS Code's in-editor schema warning over the blog posts.
The extension still carries "native-preview" branding post-GA (installed: 0.20260708.2).
- **Runtime deps: none** (`dependencies` is empty as of wave P). `wa-sqlite` is a
  **devDependency** only (`github:rhashimoto/wa-sqlite#v1.1.2`, commit `2bf1c59`,
  vendored into `dist/worker/worker.js` at build time — never reaches a consumer
  lockfile). `@lalex/promises` was removed entirely (replaced by native
  `Promise.withResolvers()`). **The `wa-sqlite` on npmjs is not the upstream package**:
  `1.0.0`, published by `gabrieldevunstatic <tailinh@unstatic.co>`, no `repository`
  field — never point B8 at it. Note the v1.1.2 tag ships a `package.json` still saying
  `"version": "1.1.1"` — upstream forgot the bump; verify by commit, not by that field.

## Build output — `dist/`

```
dist/
  index.js          client-facing entry; keeps new URL('./worker/worker.js', …) literal
  index.d.ts  client.d.ts  debug.d.ts  orchestrator.d.ts  types.d.ts  utils.d.ts
  worker/
    worker.js             monolithic: 3 Emscripten glues + 5 VFS modules inlined
    wa-sqlite.wasm
    wa-sqlite-async.wasm
    wa-sqlite-jspi.wasm
```

Sizes (wa-sqlite v1.1.2, gzip): `worker.js` 117 KB; `index.js` 4 KB; three `.wasm` 2.4 MB
raw combined (~286 KB / 451 KB / 287 KB). Only the VFS the consumer selects is fetched at
runtime; the others are tarball weight only.

### Build facts — not re-derivable without reading rslib source or re-running the probe

**rslib's `esm` preset disables four parser behaviours unconditionally**
(`node_modules/@rslib/core/dist/index.js:2880-2895`):
- `importMeta: false`, `importDynamic: false`
- `commonjs: { exports: 'skipInEsm' }`
- `worker: false`

and adds `parser({ url: false })` on the JS rule via `modifyRsbuildDefaultPlugin({
disableUrlParse: true })` (`:2909`, body `:3110`). This is deliberate — rslib contracts
that a library entry leaves `import.meta`, `import()`, `new Worker(new URL())`, and
`new URL()` intact for the consumer's bundler. The `index` entry honours this; the
`worker` entry overrides it.

**Why the worker entry uses `url: false` (not `true`):**
`url: true` causes rspack to emit wasm as content-hashed asset/resource files and rewrite
`new URL("wa-sqlite.wasm", import.meta.url)` to the webpack runtime expression
`__webpack_require__.p + "..."`, anchored by `__webpack_require__.b = new URL("./",
import.meta.url)`. Neither Rollup (which Vite uses for `format=iife` worker re-bundling)
nor a consumer's own rspack can follow this reference. With `url: false` the Emscripten
glue keeps a literal, portable `new URL("wa-sqlite.wasm", import.meta.url)`. The three
`.wasm` are then placed beside `worker.js` via rsbuild's `output.copy` — plain names, no
content hash. This was found through consumer smoke testing, not by reading the docs;
the spec's §4.3 originally predicted `url: true`.

**`distPath.wasm` (not `assets`) governs wasm output when `url: true`:** Wasm files are
emitted by the rule `test: /\.wasm$/, dependency: 'url', type: 'asset/resource'`, whose
generator filename is built from `distPath.wasm`. `output.assets` and
`output.webassemblyModuleFilename` have no effect on them. Reproduced on 2026-08-17 probe.
(Under `url: false`, no asset rule fires and `distPath.wasm` is irrelevant.)

**rslib forces the persistent build cache on** (`@rslib/core/dist/index.js:2836`). Its
digest tracks the config's resolved *values* but not its *key structure*: changing
`distPath.wasm: 'a'` to `'b'` invalidates correctly, but swapping `distPath.assets` for
`distPath.wasm` silently reuses the old output. Fixed by
`performance.buildCache.buildDependencies: [import.meta.filename]` in `rslib.config.ts`,
which hashes the config file itself. `pnpm build` is therefore always correct; no manual
`dist/` deletion is needed.

## Layout (src/)

| File | Lines | Role |
|---|---|---|
| `client.ts` | 1016 | God module: worker lifecycle, pool scheduling, dispatch, transactions, bulk ETL. Exports `createSQLiteClient` (a ~736-line factory closure), `CreateSQLiteClientOptions`, `SQLiteDB`, `SQLiteQueryOptions`, `SQLiteStreamOptions`, `DEFAULT_POOL_SIZE`, `DEFAULT_VFS`. |
| `worker/worker.ts` | 258 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Holds `VFSConfigs` (the good extensibility pattern — `satisfies Record<SQLiteVFS, …>`). Moved from `src/worker.ts` in wave P so the source tree mirrors the output tree. |
| `orchestrator.ts` | 183 | `WorkerOrchestrator`: `SharedArrayBuffer` + `Atomics` for the init mutex and per-worker status flags. `Atomics.wait` is called worker-side only. |
| `debug.ts` | 221 | Instrumentation subsystem — **entirely dead code today** (see `mem:follow-ups` B6). |
| `types.ts` | 70 | Wire protocol types; lines 1-38 are a stale duplicate that disagrees with the live one. |
| `utils.ts` | 28 | `isWriteQuery()` regex + `sqlParams`/`addParam` (exported, tested, unused by the lib). |
| `wa-sqlite.d.ts` | 80 | Hand-written 7-method `SQLiteAPI` subset shadowing wa-sqlite's own shipped types; **missing `close`**. |
| `index.ts` | 1 | `export * from './client'` |

Public API surface: `read` / `write` / `one` / `stream` / `transaction` / `close`,
plus `bulkWrite` and `output` (schema DSL + drop/recreate/populate — ETL misplaced in
the client layer).

## Key invariant, and how it is currently violated

The pool's exclusivity guarantee rests on `PoolWorker.available`. Today
`client.ts:454` (the `finally` of `worker.query()`) is the **only** place that sets it
back to `true`, and it fires per-statement — while `releaseWorker` (`client.ts:554`)
never touches the flag at all, it just hands the worker to the next queued requester.
Any owner that holds a worker across several statements (i.e. `transaction()`) sees it
republished as free after the first one. Verified in source, not just reported.

## CI / hooks

- `.github/workflows/ci.yaml` (added in wave 0) has two jobs, on push to `main` and on
  every PR; Chromium is cached by `pnpm-lock.yaml` hash, `concurrency` cancels superseded
  runs.
  - `verify` — `biome ci` + `tsc --noEmit` + `pnpm build` + `pnpm test`. Blocking.
  - `consumer-smoke` — `pnpm test:consumer`, i.e. `scripts/consumer-smoke.mjs`: builds,
    `pnpm pack`s, installs the tarball into two temp app dirs **outside** the repo (one
    Vite, one rsbuild), and drives four consumer modes with Playwright: (1) Vite dev
    server, (2) Vite build + preview, (3) rsbuild build + preview, (4) no-bundler static
    serve. Also runs a static bare-specifier assertion over `dist/**/*.js`. **Blocking as
    of wave P (2026-08-17); `continue-on-error` removed.** 11/11 stages pass.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath` in `rslib.config.ts`. Without it the root tsconfig
  pushes the common source root to the repo root: declarations would land in `dist/src/`
  while `package.json` points at `dist/index.d.ts` (published `types` field missing), and
  `dist/tests/` would ship inside the package.
- `.github/workflows/release-and-publish.yaml`, triggered on `v*` tags, build + publish only.
- Local `pre-commit` hook (simple-git-hooks): `lint-staged` + `pnpm test` (full Chromium
  suite) + `tsc --noEmit`. Heavy and bypassable with `--no-verify` — CI is now the real gate.
- `tsconfig.json` `include` is `["src", "tests", "rslib.config.ts", "rstest.config.ts"]` —
  `tests/` is type-checked as of wave 0. Only `strict` is on.

## History / process notes

- A `.planning/` directory from a previous agent framework was **deleted on 2026-08-17**.
  Its `CONCERNS.md` described a stale, partly false snapshot. Do not look for it and do
  not recreate it. The project now works with **superpowers** skills.
- The authoritative external assessment is `docs/reviews/2026-08-17-0759-browser-sqlite.md`
  (9-agent codebase review). Its findings are substantively correct — its **severity
  grading is not** (all 9 axes marked BLOCKING). Triage lives in `mem:follow-ups`.
- Sequencing and open decisions: `mem:resume-plan`.
