# Project State — `browser-sqlite`

Snapshot date: 2026-08-19 (post wave 3). Update this file when the facts below change.

## Read this first — a fact that cost a whole debugging round

**The default VFS is `OPFSPermutedVFS`**, set as `DEFAULT_VFS` in `client.ts`. The
`OPFSCoopSyncVFS` you will find in `worker/worker.ts` is only the worker's fallback when the
client passes nothing — and the client always passes something. This matters far beyond
trivia: `OPFSPermutedVFS` propagates commits to other connections **asynchronously**, over
BroadcastChannel + IndexedDB, which is why a read on another worker can serve a stale view
right after a write (see RYOW-1 in `mem:follow-ups`). An earlier version of this file said the
default was `OPFSCoopSyncVFS`; a wave-3 dispatch repeated that and sent an agent down the
wrong path for a full round.

## What it is

`browser-sqlite` v1.0.0-rc.3 — persistent SQLite in the browser: wa-sqlite (WASM) +
a Web Worker pool + OPFS/IndexedDB VFS. Concurrency model: **concurrent reads across
the pool, writes serialized through one designated writer worker**. That model is
sound and is the thing worth preserving; see `mem:follow-ups` for what is broken in
its implementation.

## Stack

Versions below are post-upgrade (2026-08-17) and verified green: `tsc --noEmit`,
`biome check`, `pnpm build`, 193 tests (unit + browser) — all pass as of wave 2.

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat,
  no `esm/` level); two explicit entries — `index` and `worker` — each with opposite
  goals (see "Build facts" below). Generated `.d.ts` via `tsgo`. Node 24.13.
- Lint/format: **biome** 2.5.8 (`biome.json`; note it locally disables `noExplicitAny`
  and `noBannedTypes`). Run `pnpm check` after every modification.
- Tests: **rstest 0.11.8** with two projects (`rstest.config.ts`):
  - `unit` — Node, pure logic → `tests/unit/{debug,errors,orchestrator,routing,scheduler,supervisor,utils}.test.ts`
    (`errors` and `supervisor` added in wave 2; `routing` and `scheduler` added in wave 1).
  - `browser` — real Chromium via Playwright →
    `tests/browser/{init,queries,concurrency,transaction,bulk-write,output,vfs,lifecycle,close,long-query,routing}.test.ts`
    plus `helpers.ts` (`createTestClient(options?)` — unique OPFS name + afterEach cleanup).
    Needs COOP/COEP headers, injected by an inline rsbuild plugin.
    **273 tests total as of wave 3** (was 193 after wave 2, 148 after wave 1, 105 after wave 0).
    Wave-3 additions: `tests/unit/{quoting,bulk,locks,logger}.test.ts` and
    `tests/browser/debug.test.ts`, plus new cases in `routing`, `scheduler`, `debug`, `init`,
    `output` and `bulk-write`.
    - Wave-2 additions: `tests/unit/{errors,supervisor}.test.ts` and
      `tests/browser/{lifecycle,close,long-query,routing}.test.ts`.
  - **rstest 0.11.8 has no `it.each`** — parameterized tests use a plain `for` loop over an
    array, calling `it()` directly (see `tests/unit/routing.test.ts` for the pattern).
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

### Two traps that cost real time in wave P — do not step in them again

- **Never put `/* webpackIgnore: true */` on the `new Worker(new URL(...))` call in
  `client.ts`.** It looks like a way to tell a consumer's bundler "this is already built,
  leave it alone". It is not: rslib strips it from `dist/index.js`, so it never reaches a
  consumer at all — but **rstest's own rspack honours it**, so no worker chunk is emitted
  at test time, the worker never loads, and the whole browser suite hangs forever with no
  error. That is B2 observed from the inside. The same applies to `/* @vite-ignore */`,
  which survives into `dist/` but only suppresses the `?worker_file` query, not the
  `import.meta.url` rewrite it was added to fight. Both were tried, both were removed.
  The real fix for consumer bundlers is `url: false`, below.
- **rsbuild has no `preview` config key** — only `server`, and `server.headers` DOES apply
  to `rsbuild preview`. Verified by probe (built app + `rsbuild preview` + curl returns
  both COOP and COEP). Vite is the one that splits `server` and `preview`; do not copy
  Vite's shape into an rsbuild config and do not "fix" a missing `preview.headers`.

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

## Wave 4's first half, merged 2026-08-20 (`5292b70`) — what changed structurally

- **`src/orchestrator.ts` is gone**, 183 lines, and with it every `SharedArrayBuffer` in the
  library. `grep -rE 'orchestrator|SharedArrayBuffer|WorkerStatuses'` over `src/` returns nothing.
  **browser-sqlite no longer requires cross-origin isolation** — no COOP/COEP headers, anywhere,
  demonstrated by the consumer smoke at 11/11 across four bundler modes with none served.
  The init mutex is now `navigator.locks` (`initLockName(file)` in `locks.ts`), the per-worker
  status is a plain `status` field on `PoolWorker` maintained by `pool.ts`, and the abort is a
  `stop` message.
- **`src/credits.ts` is new** — the pure credit gate, Node-tested like `scheduler.ts` and for the
  same reason. `createCreditGate(tick)` → `{ reset, grant, stop, take, isStopped, tick }`, plus
  `createMessageChannelTick` and `DEFAULT_CREDIT_WINDOW = 2`.
- **The load-bearing rule, easy to break and hard to see:** `take()` awaits the tick
  **unconditionally**, before checking credits. Skipping it when credits are available is the
  obvious optimisation and it destroys the property the module exists for — a worker inside a query
  otherwise never returns to its event loop, so no `postMessage` reaches it. A unit test counts
  ticks per take and goes red if anyone tries.
- `MessageChannel`, never `setTimeout`, for the tick: nested `setTimeout` is clamped to 4 ms.
- Credits are granted **on consumption** (after the `yield` in `pool.ts`'s generator), never on
  arrival. Crediting on arrival silently defeats back-pressure.
- Measured cost on the shipped code: nothing measurable at the default `chunkSize`; 12.2 µs per
  chunk in an adversarial 4000-chunk configuration.

## Layout (src/)

| File | Lines | Role |
|---|---|---|
| `client.ts` | 628 | **Assembly only** (since wave 1): options, validation, wiring, the public `SQLiteDB` surface, `close()`. No longer a god module — it was 1016 lines and held everything below. Three new options in wave 2: `maxWorkerRestarts` (default 1), `openTimeout` (default 30 000 ms), `drainTimeout` (default 60 000 ms). `close()` is now `() => Promise<void>`. |
| `errors.ts` | 25 | **New in wave 2.** `SQLiteError extends Error` with `code: SQLiteErrorCode` and `name` mirroring `code`. Five codes: `NOT_A_READ_QUERY` / `CLIENT_CLOSED` / `WORKER_CRASHED` / `TIMEOUT` / `PROTOCOL_ERROR`. Exported from `index.ts`. |
| `supervisor.ts` | 81 | **New in wave 2.** Pure per-slot restart policy, zero imports. Slot that never reached `ready` is never restarted; restart counter resets on a request actually served (not on `ready`); `maxWorkerRestarts` bounds it; an eviction leaving no live slot fails the client; `evicted` flag makes eviction permanent against a late `ready`. |
| `scheduler.ts` | 200 | **Pure** — availability (a private `Set`), both wait queues, writer designation, opaque leases. Gained `remove(index)` and `shutdown(reason)` in wave 2; a per-index generation counter makes a stale lease's `release()` inert after the slot was removed and revived. No `Worker`, no DOM, no orchestrator import — Node tests drive it in milliseconds. **This purity is load-bearing: B1 survived for months because the scheduler was only reachable through slow browser tests.** |
| `pool.ts` | 362 | Worker creation and transport: `postMessage` / `onmessage` routed by `callId`, the raw query generator, and the stop-and-drain that waits for the worker's in-flight `done` before a lease returns. `PoolWorker` now carries `interrupt()`, `quiesce()`, and `close()`. Wave 2 adds `onerror` (dead worker and the actionable load-failure message), `messageerror` (worker survives, request rejects with `PROTOCOL_ERROR`), a bounded stop-and-drain, and the `close` handshake. |
| `queries.ts` | 163 | `chunk()` — the single query primitive and **the only place `AbortSignal` is read** — plus `streamRows` / `readWorker` / `firstWorker` / `writeWorker`. Wave 2 adds `makeAbortRace` helper; the abort now races the pending chunk instead of being tested after it, and the caller never awaits the drain. |
| `transaction.ts` | 151 | `transaction()` over a single lease held for its whole lifetime. |
| `bulk.ts` | 170 | `bulkWrite()` + `output()`. Still carries B5 verbatim. Calls the **public** `write` (one lease per batch, worker released between batches) — a property D3 depends on; do not consolidate it into one held lease. |
| `worker/worker.ts` | 326 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Wave 2: `ready` only on success and `open-error` on failure; every `cause` structured-clone-probed; `sqlite.close(db)` on the `close` message; exhaustive message dispatch. Holds `VFSConfigs` (the good extensibility pattern — `satisfies Record<SQLiteVFS, …>`). |
| `orchestrator.ts` | 183 | `WorkerOrchestrator`: `SharedArrayBuffer` + `Atomics` for the init mutex and per-worker status flags. `Atomics.wait` is called worker-side only. |
| `debug.ts` | ~230 | Instrumentation subsystem — **live since wave 3** (B6 closed). `createClientDebug(file, orchestrator, clientOptions, stats)`; both history arrays bounded at 50; `queue` is getter-backed and reads through `scheduler.stats()`, so no counter can go stale. |
| `logger.ts` | ~30 | **New in wave 3.** `createLogger(prefix, enabled, sink = console)` → prefixed `console.debug/warn/error`. **Lifecycle events only** — 10 call sites, never per query. Disabled, it returns three no-op closures allocated once. |
| `locks.ts` | ~120 | **New in wave 3.** Web Locks wrapper + the pure sweep decision. Exports `createLocks`, the named `noOpLocks` constant (use this in tests — `createLocks(undefined)` falls back to the real API, and **Node 24 ships one**), `stagingTableName` / `stagingLockName` / `sweepLockName`, and the pure `staleStagingTables`. The staging lock is **not** mutual exclusion — nothing contends for its name. It is a liveness marker: held for as long as a staging table exists, so another tab's sweep can tell in-flight from orphan. A dead tab's locks are released by the browser, which is why no timestamp or grace period is needed. |
| `types.ts` | 93 | Wire protocol types plus the shared `SQLiteQueryOptions`. Lines 1-38 are still a stale duplicate that disagrees with the live one. |
| `utils.ts` | 74 | `isReadQuery` / `isWriteQuery` (allowlist since wave 1) + `assertReadable(sql, method)` (new in wave 2, throws `NOT_A_READ_QUERY` before a lease is taken) + `sqlParams`/`addParam` (exported, tested, unused by the lib). |
| `wa-sqlite.d.ts` | 81 | Hand-written 9-method `SQLiteAPI` subset shadowing wa-sqlite's own shipped types via a deep import; wave 2 added `close`. |
| `index.ts` | 2 | `export * from './client'; export * from './errors'` — `SQLiteError` is now a public export. |

Public API surface (since wave 1): `chunk` / `read` / `write` / `first` / `stream` /
`transaction` / `close`, plus `bulkWrite` and `output`. `one()` was renamed `first()`,
`stream()` yields rows rather than chunks, `chunk()` is the new chunk-wise path, and
`signal` is accepted on every method.

**Wave 2 additions to the public surface:** `SQLiteError` (exported from `index.ts`),
`close()` changed from `() => void` to `() => Promise<void>` (async, awaitable).
Three new constructor options: `maxWorkerRestarts` (default 1), `openTimeout` (default
30 000 ms), `drainTimeout` (default 60 000 ms).

**Wave 2 invariant — the lease returns on quiesce, not on the caller's exit.**
After a read method's `try` block finishes, the `finally` calls `lease.worker.quiesce()`
and only releases the lease once the worker confirms it is idle. The caller does not wait
for this — it was already handed its result. This means the lease returns when the worker
is done with `sqlite.step()`, not when the public method returns. The consequence: a
worker still inside a `step()` call is never re-lent; the pool's exclusivity guarantee
holds at the worker level, not just at the scheduler level.

**rsbuild renames the emitted worker chunk** (`webpackChunkName: "browser-sqlite"`), so
no test may assert a `worker/worker.js` substring in an error message. The lifecycle test
for the load-failure error asserts the stable wording (`'could not load its worker from'`
and `'Bundler Configuration'`) rather than the URL, for this reason.

## Wave 3 additions to the public surface (2026-08-19)

- `BulkWriteError extends SQLiteError` (code `BULK_WRITE_FAILED`) with `rowsWritten` /
  `rowsNotWritten`. Named that way, not `rowsNotAttempted` as the spec drafted: a multi-row
  INSERT is statement-atomic, so the failing batch **was** attempted and wrote nothing —
  "not attempted" would exclude exactly the rows a caller most needs counted.
- Three new error codes: `INVALID_IDENTIFIER`, `INVALID_PRAGMA`, `BULK_WRITE_FAILED`.
- `debug?: string | boolean` on the client; `db.debug` typed `ClientDebugState | undefined`.
- **`output()` lost its `temp` option** (breaking, free at rc with no consumer). It was not
  incoherent for the reason D3 §1.1 gave — staging in `temp` would rename fine within the same
  database — but for another: a TEMP table lives on one connection and is invisible to the rest
  of the pool.
- **`output()` no longer creates its target eagerly.** The previous table stays intact and fully
  populated until `close()` swaps. A concurrent reader mid-load now sees the OLD data rather than
  a half-filled new table, and a target that did not exist appears only at `close()`.
- `bulkWrite`/`output` are single-use: `enqueue()` and `close()` throw once closed.
- Read PRAGMAs work through `read()` again; a PRAGMA that assigns or takes an argument is a write.

## Scheduling rules as of wave 3 — settled with the user, and one is measured

Three rules, and the third is the one nobody may relax casually:

1. **A read never touches the writer designation** — it does not take the writer by preference,
   and it does not clear the designation when the writer happens to serve it. Both acquisition
   paths behave identically. (`handOver` used to clear it while `takeAvailable` preferred the
   writer and kept it — the two disagreed, and the user called that out.)
2. **No preference of any kind when choosing a worker for a read.** Lowest-index-first.
3. **The writer designation is sticky, and this is now evidence-backed.** The user asked for it to
   be released once no write is outstanding or queued, so a following write could take the first
   free worker. That was built, measured and reverted: consecutive writes on different workers
   fail with `no such table`, because `sqlite3_prepare_v2` reads the schema through the worker's
   stale page map *before* `SQLITE_LOCK_RESERVED` is requested. `OPFSPermutedVFS` does detect
   staleness at that lock and signals `SQLITE_BUSY`, which wa-sqlite retries — but a failed
   prepare returns `SQLITE_ERROR`, which it does not. **Relaxing stickiness requires a real
   commit-propagation barrier first (wave 4, BP-1).**

Consequence: read-your-own-writes across workers is not guaranteed, and nothing in the scheduler
pretends otherwise. See RYOW-1 in `mem:follow-ups`.

## Key invariant — established in wave 1, do not weaken it

Exclusivity rests on availability being **unreachable from outside `scheduler.ts`**.
`PoolWorker` carries no `available` field: it was deleted, not guarded. Workers are handed
out as `Lease` objects whose `release()` is idempotent and is the only way back into the
pool. `transaction()` holds one lease for its whole lifetime.

This replaced the wave-0 state, where `client.ts`'s per-statement `finally` was the only
writer of `available` and republished a borrowed worker after every statement — so a
concurrent `read()` could execute *inside* an open transaction (B1).

**Two things that look like tidying but would reopen B1:**
- adding any availability flag to the worker object, however well-guarded;
- making a worker-bound helper in `queries.ts` release a lease it did not acquire. The
  public methods own their leases; the worker-bound variants own nothing. Keep the two
  forms distinguishable by name.

Routing is part of the same guarantee: `isReadQuery` (`utils.ts`) is an allowlist requiring
an allowlisted opening keyword **and** no write keyword anywhere in the statement. The
second clause is not decoration — the worker executes `;`-separated statements, so
`SELECT 1; DROP TABLE t` opens as a read and is not one.

### A TypeScript 7 trap paid for in wave 1

`const x: (() => T) | undefined = undefined` narrows to `undefined`, and TS 7 then reports
"Type 'never' has no call signatures" at `x?.()`. Writing `undefined as (() => T) | undefined`
preserves the union. It cost real time in `pool.ts`'s debug hooks; expect it again wherever a
placeholder `undefined` must keep a callable union type.

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
