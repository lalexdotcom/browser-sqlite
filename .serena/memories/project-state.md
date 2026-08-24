# Project State — `browser-sqlite`

Snapshot date: **2026-08-24** (post wave 4, post VFS branch, post barrier, post stickiness).
Update this file when the facts below change — it went four days out of date on the VFS and
caused a false statement to the user.

## Read this first — the VFS facts, twice corrected

**The default VFS is `OPFSAdaptiveVFS` on the Asyncify build**, `DEFAULT_VFS` in `client.ts:324`.
`OPFSPermutedVFS` is **gone from the codebase** — removed, not deprecated in place, by
`feat/vfs-default` (merge `be314db`, 2026-08-20): it measured 24 % stale cross-connection reads
and is deprecated upstream (rhashimoto/wa-sqlite#317). `grep -rn Permuted src/ README.md tests/`
returns nothing.

The five public VFS are declared in **one** table, `VFS_BUILDS` in `types.ts:84`, which is also
what the `SQLiteVFS` type derives from: `OPFSAdaptiveVFS` (async, jspi), `OPFSWriteAheadVFS`
(sync, async, jspi), `OPFSCoopSyncVFS` (sync, async, jspi), `AccessHandlePoolVFS` (sync, async,
jspi), `IDBBatchAtomicVFS` (async, jspi). A `build` client option selects the wa-sqlite build;
an undeclared pair throws `SQLiteError('INVALID_OPTION')` synchronously at construction, like the
`AccessHandlePoolVFS` pool guard.

**Every VFS is constructed with `{ lockPolicy: 'shared' }`** (`worker/worker.ts:134`) — upstream's
recommendation in rhashimoto/wa-sqlite#302 for exactly our shape, a pool of workers reading
concurrently. It reaches `WebLocksMixin`, which `OPFSAdaptiveVFS` extends. **`OPFSCoopSyncVFS` does
not extend `WebLocksMixin`** — it implements `jLock`/`jUnlock` itself and silently ignores the
option. That is part of why COOP-1 exists.

Staleness is **not** a property of any one VFS: it is a property of the multi-connection setup,
measured identical on every VFS and every build (40 runs, 40 stale). This is why the barrier is
permanent architecture rather than a workaround for a bad default. See RYOW-1 in `mem:follow-ups`.

**Two corrections this very block has had to absorb, both of which cost real time.** It once said
the default was `OPFSCoopSyncVFS`; a wave-3 dispatch repeated that and sent an agent down the wrong
path for a full round. It then said the default was `OPFSPermutedVFS` and kept saying it for four
days after that VFS was deleted, which caused a false statement about the project's reliability to
the user on 2026-08-24. **When the VFS choice changes, this block is the first thing to rewrite.**

## Engine capabilities — measured 2026-08-24, not deduced

Probe run in a dedicated worker on a secure `http://localhost` page, against Playwright's own
builds (Chromium 151, Firefox 153, WebKit 26.5, all arm64/Linux).

| moteur | `isSecureContext` | `storage.getDirectory` | `FileSystemSyncAccessHandle` | 2nd `readwrite-unsafe` handle |
|---|---|---|---|---|
| Chromium | ✅ | `function` | `function` | **succeeds** — mode honoured |
| Firefox | ✅ | `function` | `function` | **`NoModificationAllowedError`** — mode ignored |
| WebKit (Linux) | ✅ | **`undefined`** | **`undefined`** | — |

Consequences, each of which cost a measurement:

- **Firefox is the only engine here that exercises `OPFSAdaptiveVFS`'s degraded path**, and it does
  so correctly: 102/104 browser tests, two concurrent reads overlapping at ratio **1.03** (Chromium
  control 0.88). See RWU-1, closed.
- **Firefox is ~5.5× slower** than Chromium on the same CPU-bound query (4192 ms vs 755 ms for
  `longQuery(3_000_000)`). Every Chromium-calibrated timing constant in the suite is suspect.
- **WebKit on Linux has no `navigator.storage` at all** — not a partial OPFS, the whole
  StorageManager is missing. It cannot exercise any VFS this library ships and is removed from CI
  and the devcontainer (`ee2e9f3`). A real WebKit signal needs Playwright on macOS.
- **The dividing line for pool behaviour is the synchronous access handle, not `readwrite-unsafe`.**
  See HANDLE-1 in `mem:follow-ups`: any VFS that rotates one exclusive handle serializes the whole
  pool for the duration of a long uninterruptible statement, and that includes `OPFSCoopSyncVFS`.

Test tooling: **Chromium and Firefox** are installed by `.devcontainer/post-create.sh` and by both
CI jobs, under a cache key that names them. `rstest.config.ts` still runs **Chromium alone** — the
matrix is possible, not yet enabled. rstest accepts no provider but `playwright`.

## Memory footprint — one axis of VFS choice, corrected by the user 2026-08-24

**Origin:** the user started the project to stop loading large data structures into RAM, and
assumes other consumers arrive for that reason. Not derivable from any line of code.

**But it is one criterion among several, not the governing one — the user corrected exactly this
over-weighting on 2026-08-24.** A VFS that is frugal and slow is as useless as one that is fast and
enormous. The axes are footprint, throughput and latency, whether the pool actually runs
concurrently, durability, and browser compatibility; the balance between them is the whole
question, and **no axis vetoes on its own.** What the library owes a consumer is every cursor made
visible, not a ranking.

Footprint earns a declared field anyway, for a narrower reason: it is currently the one axis a
consumer cannot see at all, where builds, concurrency and persistence are at least discoverable.

**Consequence for `IDBMirrorVFS`, stated as a trade and not a verdict:** it is upstream's fastest
option with and without contention and it escapes HANDLE-1 — two axes won outright — against a
footprint proportional to database size × `poolSize`, one axis lost outright. **Which way that
falls is for the measurement campaign to settle; do not pre-empt it.** An earlier version of this
entry declared it disqualified as a default on footprint alone. That was the over-weighting.

Memory model per VFS, which the README must carry as a column and today does not:

| VFS | memory model |
|---|---|
| OPFS VFS (`Adaptive`, `CoopSync`, `AnyContext`, `AccessHandlePool`) | page cache only (`PRAGMA cache_size`) — bounded and tunable |
| `IDBBatchAtomicVFS` | page cache, with a floor: upstream notes "the cache size must be set large enough to hold the journal" |
| `IDBMirrorVFS` | **whole database in RAM**, not bounded by configuration |
| `MemoryVFS` / `MemoryAsyncVFS` | whole database in RAM, volatile, single connection |

Cross-cutting and also undocumented: **`poolSize` multiplies the footprint** whatever the VFS,
since every worker holds its own page cache. Default is 2.

## What it is

`browser-sqlite` v1.0.0-rc.3 — persistent SQLite in the browser: wa-sqlite (WASM) +
a Web Worker pool + OPFS/IndexedDB VFS. Concurrency model: **concurrent reads across
the pool, writes serialized through one designated writer worker**. That model is
sound and is the thing worth preserving; see `mem:follow-ups` for what is broken in
its implementation.

## Stack

Versions below are post-upgrade (2026-08-17). Last verified green on `main` **2026-08-24**:
`tsc --noEmit`, `biome check`, `pnpm build`, **308 tests (unit + browser), 0 failures**.

- **TypeScript 7.0.2** (the native/Go compiler — `tsc` resolves a per-platform binary),
  ESM only, `type: module`. Build: **rslib 0.23.2** (`rslib.config.ts`) → `dist/` (flat,
  no `esm/` level); two explicit entries — `index` and `worker` — each with opposite
  goals (see "Build facts" below). Generated `.d.ts` via `tsgo`. Node 24.13.
- Lint/format: **biome** 2.5.8 (`biome.json`; note it locally disables `noExplicitAny`
  and `noBannedTypes`). Run `pnpm check` after every modification.
- Tests: **rstest 0.11.8** with two projects (`rstest.config.ts`):
  - `unit` — Node, pure logic, 13 files → `tests/unit/{bulk,credits,debug,epochs,errors,locks,
    logger,quoting,routing,scheduler,supervisor,transaction,utils}.test.ts`.
  - `browser` — real Chromium via Playwright, 15 files + `helpers.ts` →
    `tests/browser/{backpressure,barrier,bulk-write,close,concurrency,debug,init,lifecycle,
    long-query,output,queries,routing,transaction,vfs,writer-spread}.test.ts`.
    `helpers.ts` exposes `createTestClient(options?)` — unique OPFS name + afterEach cleanup.
    **No COOP/COEP headers anywhere** since the SAB was removed in wave 4 — if you find a
    reference to them in this file or the config, it is stale.
  - **308 tests total, 0 failures, re-verified on `main` 2026-08-24** (was 272 after wave 4's
    first half, 272 after wave 3, 193 after wave 2, 148 after wave 1, 105 after wave 0).
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
  index.d.ts  client.d.ts  debug.d.ts  errors.d.ts  types.d.ts  utils.d.ts  (one per src module;
                    orchestrator.d.ts is gone with its source)
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

Line counts verified 2026-08-24. `orchestrator.ts` is **deleted** — do not look for it.

| File | Lines | Role |
|---|---|---|
| `client.ts` | 835 | **Assembly only** (since wave 1): options, validation, wiring, the public `SQLiteDB` surface, `close()`. It was 1016 lines and held everything below. Holds `DEFAULT_VFS` (`:324`), the vfs/build guard (`:391`), `applyBarrier` (`:457`) and `acquireInstrumented` (`:513`) — **the single choke point through which every read, write, transaction and bulk acquires a lease**, which is what makes the barrier one wrapper rather than six. |
| `errors.ts` | 60 | `SQLiteError extends Error` with `code: SQLiteErrorCode` and `name` mirroring `code`, plus `BulkWriteError`. **Ten codes:** `NOT_A_READ_QUERY`, `CLIENT_CLOSED`, `WORKER_CRASHED`, `TIMEOUT`, `PROTOCOL_ERROR`, `INVALID_IDENTIFIER`, `INVALID_OPTION`, `INVALID_PRAGMA`, `BULK_WRITE_FAILED`, `BUSY`. |
| `supervisor.ts` | 94 | Pure per-slot restart policy, zero imports. Slot that never reached `ready` is never restarted; restart counter resets on a request actually served (not on `ready`); `maxWorkerRestarts` bounds it; an eviction leaving no live slot fails the client; `evicted` flag makes eviction permanent against a late `ready`. **`spawned` event added 2026-08-21 (`07b075a`) — a slot holds a worker from creation, not from `ready`** (SUP-1). |
| `scheduler.ts` | 274 | **Pure** — availability (a private `Set`), both wait queues, writer designation, opaque leases, `remove(index)`, `shutdown(reason)`, per-index generation counter. No `Worker`, no DOM. Node tests drive it in milliseconds. **This purity is load-bearing: B1 survived for months because the scheduler was only reachable through slow browser tests.** |
| `pool.ts` | 458 | Worker creation and transport: `postMessage` / `onmessage` routed by `callId`, the raw query generator, the stop-and-drain that waits for the worker's in-flight `done` before a lease returns, `onerror` / `messageerror`, the `close` handshake, and the per-worker `status` field that replaced the SAB status byte. |
| `queries.ts` | 167 | `chunk()` — the single query primitive and **the only place `AbortSignal` is read** — plus `streamRows` / `readWorker` / `firstWorker` / `writeWorker` and `makeAbortRace`. |
| `transaction.ts` | 177 | `transaction()` over a single lease held for its whole lifetime. Evicts a worker whose fallback `ROLLBACK` failed. |
| `bulk.ts` | 336 | `bulkWrite()` + `output()`. Calls the **public** `write` (one lease per batch, worker released between batches) — a property D3 depends on; do not consolidate it into one held lease. |
| `worker/worker.ts` | 372 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Holds `VFSConfigs` (VFS loaders only) and `WA_SQLITE_BUILDS` (keyed by build name). **Constructs every VFS with `{ lockPolicy: 'shared' }` at `:134`.** `ready` only on success, `open-error` on failure; every `cause` structured-clone-probed; exhaustive message dispatch. |
| `credits.ts` | 94 | **Wave 4.** The pure credit gate, Node-tested like `scheduler.ts` and for the same reason. `createCreditGate(tick)` → `{ reset, grant, stop, take, isStopped, tick }`, plus `createMessageChannelTick` and `DEFAULT_CREDIT_WINDOW = 2`. |
| `epochs.ts` | 89 | **The commit-propagation barrier's state.** A per-database commit epoch in the realm-wide symbol registry (`REGISTRY_KEY = Symbol.for('browser-sqlite.epochs.v1')`), so every client in a tab shares it. Exports `epochsFor`, `advanceSeen`, `BARRIER_SQL`. Node-tested. |
| `debug.ts` | 236 | Instrumentation subsystem, live since wave 3 (B6 closed). Both history arrays bounded at 50; `queue` is getter-backed and reads through `scheduler.stats()`, so no counter can go stale. |
| `logger.ts` | 30 | `createLogger(prefix, enabled, sink = console)`. **Lifecycle events only** — never per query. Disabled, it returns three no-op closures allocated once. |
| `locks.ts` | 101 | Web Locks wrapper + the pure sweep decision. Exports `createLocks`, the named `noOpLocks` constant (use this in tests — `createLocks(undefined)` falls back to the real API, and **Node 24 ships one**), `initLockName`, `stagingTableName` / `stagingLockName` / `sweepLockName`, and the pure `staleStagingTables`. The staging lock is **not** mutual exclusion — nothing contends for its name. It is a liveness marker: held for as long as a staging table exists, so another tab's sweep can tell in-flight from orphan. A dead tab's locks are released by the browser, which is why no timestamp or grace period is needed. |
| `types.ts` | 111 | Wire protocol types, `SQLiteQueryOptions`, and **`VFS_BUILDS` (`:84`) — the single source of truth for which builds each VFS runs on**, with `SQLiteVFS` derived from its keys and `defaultBuildFor()` reading its first entry. Adding a VFS without a loader, or a build without a module, fails to compile. |
| `utils.ts` | 205 | `isReadQuery` / `isWriteQuery` (allowlist) + `assertReadable(sql, method)` + `quoteIdent` / `renderPragmas` + `sqlParams` / `addParam`. |
| `wa-sqlite.d.ts` | 81 | Hand-written `SQLiteAPI` subset shadowing wa-sqlite's own shipped types via a deep import. |
| `index.ts` | 2 | `export * from './client'; export * from './errors'`. |

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

## Public surface added after wave 3 (VFS branch + barrier, 2026-08-20/21)

- **`build?: 'sync' | 'async' | 'jspi'`** client option, validated synchronously at construction.
- **`SQLiteError` codes `INVALID_OPTION` and `BUSY`.** `INVALID_OPTION` was introduced because the
  vfs/build guard first threw `INVALID_IDENTIFIER` — a code meant for SQL identifier problems — so
  a caller discriminating on `code` would have filed an option mistake as a query mistake.
- **`SQLiteVFS` no longer includes `OPFSPermutedVFS`** and now includes `OPFSWriteAheadVFS`.
  Breaking, accepted at rc: a consumer passing the old value no longer compiles, which is the
  point.

## What the README documents today — read it before changing any of this

`README.md` sections: Install, Bundler Configuration (+ Vite), **VFS Selection (`:56`) + Builds
(`:70`)**, Usage (Initialize / Read / Write / Stream / First / Advanced / Options / Close),
Error handling, Requirements, Known Limitations.

**VFS Selection (`:60-68`)** is one table with a Builds column — deliberately one table rather than
two that could drift, and it names `VFS_BUILDS` as the source of truth. Its five rows:

| VFS | Documented constraint | Documented role |
|---|---|---|
| `OPFSAdaptiveVFS` **(default)** | None — adapts to the platform, `poolSize >= 1` | General purpose, best choice for most applications |
| `OPFSWriteAheadVFS` | **Chromium-only, fails silently elsewhere**; not covered by the test suite | WAL implemented inside the VFS |
| `OPFSCoopSyncVFS` | *"None — cooperative sync"* | *"Broader browser compatibility fallback. See Known Limitations before using it with `poolSize > 1`."* |
| `AccessHandlePoolVFS` | **`poolSize` must be `1`** — throws otherwise | Single-connection scenarios |
| `IDBBatchAtomicVFS` | None | Fallback when OPFS is unavailable |

**Two defects in that table, both found 2026-08-24, both open:**
1. **The CoopSync row's cross-reference is dangling.** It sends the reader to Known Limitations
   "before using it with `poolSize > 1`", and **there is no CoopSync entry in Known Limitations**
   (`:241-248` lists only AccessHandlePool, jspi, WriteAhead and the RYOW caveat). The README warns
   of a hazard and then documents nothing. See COOP-1 in `mem:follow-ups`.
2. **Its "Constraint: None" is false as measured.** CoopSync holds an *exclusive* access handle, so
   a pool does not read concurrently on it — it rotates one handle. Measured 2-3× slower than the
   default at `poolSize` 4.

**Requirements (`:237`)** correctly states that no special HTTP headers are needed — that is wave
4's payoff and it must not regress. It also carries the note that the "Coop" in `OPFSCoopSyncVFS`
means *cooperative*, not `Cross-Origin-Opener-Policy`.

## Scheduling rules — rules 1 and 2 as of wave 3, rule 3 rewritten 2026-08-21

1. **A read never touches the writer designation** — it does not take the writer by preference,
   and it does not clear the designation when the writer happens to serve it. Both acquisition
   paths behave identically. (`handOver` used to clear it while `takeAvailable` preferred the
   writer and kept it — the two disagreed, and the user called that out.)
2. **No preference of any kind when choosing a worker for a read.** Lowest-index-first.
3. **The writer designation is released as soon as no write is queued behind it** (commit
   `e2f454b`, 2026-08-21). `handOver` clears it, below the `serveWriterFirst` call: reaching that
   line proves the writer queue is empty, and since a worker holds one lease at a time no write is
   in flight either. **Consequence worth carrying: `designated` and `leased` now coincide** — the
   designation cannot outlive the lease, so a read can never meet an available designated worker.
   Rule 1 therefore has no observable failure mode left; the test that pinned it was deleted rather
   than kept green for the wrong reason.

   ~~Sticky, and evidence-backed: consecutive writes on different workers fail with `no such
   table`, because `sqlite3_prepare_v2` reads the schema through the stale page map before
   `SQLITE_LOCK_RESERVED` is requested.~~ **That evidence is not wrong, it is answered.**
   `applyBarrier` covers `kind: 'write'`, so a newly designated writer absorbs the previous commit
   before it prepares anything. The old reasoning stays here because anyone tempted to remove the
   barrier must know it is what holds this rule up.

   What it bought, measured (poolSize 2, a long read holding worker 0): five writes in **30-32 ms**
   spread onto worker 1, against **934-1052 ms** pinned behind the read. What it did not buy: on
   alternating, mixed and read-heavy loads it is neutral on preludes *and* on wall clock. This is a
   fix for the pathological case, not a throughput win — do not claim otherwise.

Consequence: read-your-own-writes is guaranteed within the tab (the barrier), not across tabs.
See RYOW-1 in `mem:follow-ups`.

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
