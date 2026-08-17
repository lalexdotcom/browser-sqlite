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
  ESM only, `type: module`. Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/esm`;
  it generates the `.d.ts` with `tsgo`. Node 24.13 in the container.
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
- Runtime deps: `@lalex/promises` (only for `defer()`), `wa-sqlite` pinned as a **raw
  GitHub dependency** (`github:rhashimoto/wa-sqlite#v1.0.9`) — not on npm.

## Layout (src/, 1857 lines total)

| File | Lines | Role |
|---|---|---|
| `client.ts` | 1016 | God module: worker lifecycle, pool scheduling, dispatch, transactions, bulk ETL. Exports `createSQLiteClient` (a ~736-line factory closure), `CreateSQLiteClientOptions`, `SQLiteDB`, `SQLiteQueryOptions`, `SQLiteStreamOptions`, `DEFAULT_POOL_SIZE`, `DEFAULT_VFS`. |
| `worker.ts` | 258 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Holds `VFSConfigs` (the good extensibility pattern — `satisfies Record<SQLiteVFS, …>`). |
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
    `pnpm pack`s, scaffolds `tests/consumer/` (a Vite app) into a temp dir **outside** the
    repo, `npm install`s the tarball there, and drives it with Playwright in both Vite dev
    and `build` + `preview`. This is the only thing that exercises `dist/`, the `exports`
    map and third-party worker resolution. **`continue-on-error: true` — known failing
    until wave 4 (see B10).** Flip it off once B10 is fixed.
- `tsconfig.build.json` (`include: ["src"]`, `rootDir: "src"`) drives declaration
  generation via `source.tsconfigPath` in `rslib.config.ts`. Without it the root tsconfig
  pushes the common source root to the repo root: declarations landed in `dist/esm/src/`
  while `package.json` points at `dist/esm/index.d.ts` (so the published `types` field
  pointed at a missing file), and `dist/esm/tests/` shipped inside the package.
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
