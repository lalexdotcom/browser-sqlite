# Codebase Review — `browser-sqlite`

*2026-08-17 — 20 source/test/config files scanned (8 `src/`, 7 `tests/`, 5 config) — 9 agents (bugs, types, security, robustness, architecture, best-practices, readability, performance, test)*
*Axes skipped: internal conventions*

**Scope.** `browser-sqlite` v1.0.0-rc.3 — persistent SQLite in the browser over wa-sqlite (WASM),
Web Workers and OPFS/IndexedDB VFS, with a concurrent-reads / serialized-writes worker-pool model.
The review judges the code both as it stands and as a design input for further work.

**Note on the repo's own docs.** `.planning/codebase/CONCERNS.md` describes a *stale* snapshot: it
reports a `squared()` placeholder test, `@ts-expect-error` on wa-sqlite imports, and an inverted
pragma condition — none of which match the current source (the pragma bug is fixed,
`wa-sqlite.d.ts` now exists). Conversely it misses every issue below. Do not use it as ground truth.

---

## Global verdict: 🔴 BLOCKING

The architecture — a worker pool offering concurrent reads and a serialized writer over wa-sqlite —
is sound and worth keeping. The **implementation of its central guarantee is not**: the pool's
exclusivity invariant is broken by a second, competing source of truth for worker availability.
Combined with the total absence of worker-failure handling and of tests on the three most stateful
methods, the library is not production-safe as written.

---

## Agent summary

| Agent | Verdict | Summary |
|-------|---------|---------|
| Bugs | 🔴 BLOCKING | Transaction workers leak back into the pool between statements; `close()` hangs in-flight callers; early `break` on `stream()` leaves the worker stepping SQL. |
| Robustness | 🔴 BLOCKING | No `onerror`/timeout anywhere → crashed worker = permanent hang + write deadlock; `open()` failure masquerades as READY; `bulkWrite` silently drops batches after a failure; `output()` is non-atomic. |
| Security | 🔴 BLOCKING | `bulkWrite()`/`output()` interpolate caller identifiers into SQL, and wa-sqlite's `statements()` executes `;`-separated statements — a real stacked-query injection primitive. |
| Architecture | 🔴 BLOCKING | 1016-line god module; dead instrumentation subsystem; `SQLiteDB` public type already drifted; `output()` is ETL misplaced at the client layer; no seam for migrations or multi-tab. |
| Types | 🔴 BLOCKING | `{} as ReturnType<typeof createClientDebug>` makes a public field's type claim a value that is always `undefined`; shipped `.d.ts` leaks unnameable internal types. |
| Performance | 🔴 BLOCKING | No prepared-statement cache; `stream()` has no back-pressure (defeating its own documented memory guarantee); no default WAL/NORMAL pragmas. |
| Best Practices | 🔴 BLOCKING | wa-sqlite shipped as a raw GitHub `dependencies` entry breaks registry-mirrored installs; the whole `SharedArrayBuffer`/COOP+COEP tax is self-imposed and avoidable. |
| Test | 🔴 BLOCKING | `transaction()`, `bulkWrite()`, `output()` have **zero** coverage; several concurrency assertions cannot fail; no CI runs the suite. |
| Readability | 🔴 BLOCKING | Debug wiring is a type-cast lie that misleads maintainers; 736-line factory closure; README/JSDoc contradict the code on PRAGMA application. |

---

## ✅ What works — keep this

These are genuine strengths, independently confirmed:

- **The concurrency model itself.** "Concurrent reads on a pool, writes serialized through one
  designated worker" is the right shape for browser SQLite, and the public API
  (`read`/`write`/`one`/`stream`/`transaction`/`close`) reads well and covers the real use cases.
- **The VFS registry.** `VFSConfigs` in `src/worker.ts:32-71`, typed
  `satisfies Record<SQLiteVFS, { fs; module }>` against the `SQLiteVFS` union shared with the public
  options, makes adding a VFS a one-place change with compiler-enforced exhaustiveness. This is the
  one part of the codebase that already answers "how do I extend this later" cleanly — reuse the
  pattern elsewhere.
- **Core query paths are properly parameterized.** `read`/`write`/`one`/`stream` bind values through
  wa-sqlite; the injection surface is confined to `bulkWrite`/`output`/pragmas (identifiers only).
- **Row materialization is not prototype-pollutable** (`Object.fromEntries`, not `obj[col] = …`).
- **`stream()` as an async generator** is the right API shape, and its `try/finally` does release the
  worker on normal exhaustion, `break`, and consumer throw.
- **The `WorkerStatus` numeric literal union** (`src/orchestrator.ts:36`) is a correct design given
  the value must live in an `Int32Array` — a richer union isn't representable across that boundary.
- **The two-project Rstest split** (Node `unit` for pure logic, real-Chromium `browser` for
  integration) is the right testing architecture; the problem is coverage, not structure.
- **COOP/COEP is documented with a clear, synchronous failure mode** — no silent degradation.

---

## 🔴 Blocking issues

### B1 — The pool has two competing sources of truth for "worker is available"
**Files**: `src/client.ts:452-456` (the `finally` in `worker.query()`) vs. `src/client.ts:554-578`
(`releaseWorker`)
*Reported independently by Bugs, Robustness and Best Practices — the single most serious defect.*

`worker.query()`'s `finally` sets `worker.available = true` the instant **any one statement**
finishes, regardless of who owns the worker. `releaseWorker()` is the intended owner of that flag.
Two concrete failures follow:

1. **Transactions lose exclusivity.** `transaction()` (`client.ts:910-976`) acquires a worker once
   and holds it across the callback, but every internal statement goes through
   `readWorker`/`writeWorker`, which drive `worker.query()` — so right after `BEGIN` resolves, the
   worker is advertised as free. Any concurrent `db.read()`/`db.write()` during an `await` gap in
   the callback can be handed **the same connection** and execute arbitrary SQL *inside* the open
   transaction, to be committed or rolled back with it. Trivially reproducible with `poolSize: 1`.
2. **`stream()` early `break` releases a still-working worker.** Unlike `one()`, `stream()` wires no
   internal `AbortController`, so `break` never sets `ABORTING`. The worker thread keeps calling
   `sqlite.step()` while the client considers it available — a second query can then start on the
   same connection, which SQLite does not support (`SQLITE_MISUSE`, wrong rows, corruption). The
   JSDoc explicitly recommends `break` as the safe exit.

**Fix**: make `releaseWorker()` the *only* place that flips `available`. Add an explicit
pinned/held flag that `acquireWorker()` also checks, and have `stream()` abort its own internal
signal in the generator's `finally`, only marking the worker free once the worker acknowledges the
abort.

### B2 — No worker-failure handling and no timeouts anywhere
**Files**: `src/client.ts:326-474` (no `onerror`/`onmessageerror`), `src/worker.ts:141`, `:153`

There is no `worker.onerror`, no `worker.onmessageerror`, and no request timeout in the entire
codebase. Three distinct paths therefore hang the caller **forever**:

- A worker crash (uncaught exception, WASM trap, OOM) means no `chunk`/`done`/`error` ever arrives;
  `deferredChunk` never settles and `available` stays `false` permanently. If that worker was the
  designated writer, **every future write deadlocks** in `writerRequestQueue` with no diagnostic.
- `open()`'s `.finally()` (`worker.ts:141-151`) runs unconditionally, so a **failed database open**
  still posts `ready` and sets status READY. The client marks the worker available; every query
  routed to it then fails with a generic error and the real cause — e.g. another tab holding an
  exclusive OPFS lock — is never surfaced. This is the entire multi-tab failure mode, silently
  degraded.
- The error reply path (`worker.ts:236`) `postMessage`s `cause: e.cause` with no try/catch; a
  non-cloneable cause throws inside the catch block, and with no `onerror` the caller never learns.

**Fix**: `onerror`/`onmessageerror` handlers that reject pending deferreds and evict/respawn the
worker; post a distinct `open-error` message instead of `ready` on open failure; wrap the error
reply and fall back to a message-only payload; add a per-request timeout as defense in depth.

### B3 — `close()` abandons in-flight and queued work
**File**: `src/client.ts:981-987`
*Bugs + Robustness + Test.*

`close()` only calls `worker.terminate()`. It never rejects live `deferredChunk`/`deferredInit`
promises, and never drains `readerRequestQueue`/`writerRequestQueue`. Any query in flight or queued
at that moment hangs permanently — no resolve, no reject, no error. Querying *after* `close()` is
worse: the pool is empty, so the request is pushed onto a queue nothing will ever drain.

**Fix**: reject all pending deferreds and both queues with an explicit "client closed" error before
terminating. Make post-close queries reject immediately.

### B4 — SQL injection through unescaped identifiers
**Files**: `src/client.ts:785` (`bulkWrite`), `:837-886` (`output`), `src/worker.ts:110` (pragmas)

`bulkWrite` builds `INSERT INTO ${table} (${keys.join(',')})` and `output` builds
`DROP TABLE IF EXISTS ${table}` / `CREATE TABLE ${table}(${name} ${type} …)` /
`CREATE INDEX … ON ${table}(${columns})` by raw interpolation, with no quoting or validation — and
the `type`/`generated` schema fields are free-form SQL fragments spliced into DDL. This is not
merely a malformed-identifier risk: wa-sqlite's `statements()` iterates `;`-separated statements and
executes each (which is exactly how the worker prepends pragmas), so `x; DROP TABLE users; --` is a
working **stacked-query injection**. Pragma keys/values have the same unbindable-identifier problem
at lower likelihood (developer-controlled config today).

**Fix**: one shared `quoteIdent()` helper (double-quote + escape embedded quotes, or an
`^[A-Za-z_][A-Za-z0-9_]*$` allowlist) used by every identifier-taking API; an allowlist for pragma
keys and validation of pragma values; document the trust boundary for `type`/`generated`.

### B5 — Data loss in `bulkWrite()` and `output()`
**Files**: `src/client.ts:780-791`, `:815-894`

- `flush()` chains each batch inside `.then(...)` of the shared `writePromise`. Once one batch
  rejects, every later `.then(onFulfilled)` is **skipped** — but the rows were already `splice`d out
  of the buffer. So all subsequent batches are silently discarded, and the caller learns only about
  the *first* failure, only at `close()`, with no indication how many batches were dropped.
- `output()` issues `DROP TABLE`, `CREATE TABLE`, the bulk insert, and each `CREATE INDEX` as
  **separate un-transacted writes**. A failure or tab close between DROP and CREATE leaves the table
  gone with nothing to replace it — outright data loss.

**Fix**: wrap the whole `output()` sequence in a single `transaction()`; surface per-batch failures
explicitly instead of absorbing them into a shared rejected chain.

### B6 — The debug/instrumentation subsystem is dead code, and its type lies about it
**Files**: `src/client.ts:302-307`, all of `src/debug.ts` (221 lines)
*Reported by 7 of 10 agents.*

```ts
const { state: debug, createRequestDebugState, createWorkerDebugState, createQueryDebugState } =
  {} as ReturnType<typeof createClientDebug>;
```

`createClientDebug` is imported `import type` only and never called. At runtime all four bindings
are `undefined`, so every `debug?.` / `if (debug)` call site is a permanent no-op and `debug.ts` is
unreachable. Two consequences beyond the dead weight:

- **The public contract is unsound.** Because the cast forces the full non-optional `ClientDebugState`
  type, a consumer writing `db.debug.workers[0].status` type-checks cleanly and throws at runtime.
- **There is no way to observe the performance problems below.** The queue-depth and per-query timing
  instrumentation that would validate any fix is exactly what's inert.

**Fix**: call it for real behind an explicit `debug?: boolean` option (which `CreateSQLiteClientOptions`
doesn't even have today), or delete the subsystem. Never cast `{}` to a shape.

### B7 — Three of the most stateful methods have zero tests
`transaction()`, `bulkWrite()` and `output()` are referenced by **no test file at all** — nor is the
`AccessHandlePoolVFS` + `poolSize > 1` guard, the one documented VFS constraint. That is precisely
why B1, B5 and B6 went unnoticed. Compounding it:

- **No CI runs the tests.** The only workflow triggers on version tags and just builds/publishes.
  The sole gate is a local, bypassable `pre-commit` hook that runs the *full* Chromium suite on every
  commit — heavy enough that contributors will habitually `--no-verify`.
- **Several existing assertions cannot fail.** `concurrency.test.ts:167` asserts
  `chunkCount <= 3` on a 3-row table — always true regardless of abort handling. The
  "concurrent reads" / "serialized writes" blocks only check `Promise.all` correctness; they would
  pass identically if every request ran sequentially.
- **`tests/` is in no tsc program.** `tsconfig.json`'s `include` is `["src", "rslib.config.ts",
  "rstest.config.ts"]`, and the pre-commit hook runs `tsc --noEmit` against that same config — so
  test files are never type-checked, only executed.

### B8 — Packaging: wa-sqlite ships as a raw GitHub dependency
**File**: `package.json` — `"wa-sqlite": "github:rhashimoto/wa-sqlite#v1.0.9"`

This entry travels into every consumer's lockfile. Anyone behind a registry proxy (Verdaccio,
Artifactory, Nexus — i.e. most corporate/offline CI) cannot install it, and there is no npm
provenance or integrity metadata. wa-sqlite genuinely isn't on npm, so the fix must happen here:
vendor the prebuilt WASM+glue into `dist` at build time, or declare it a documented `peerDependency`
— but do not let a transitive git dependency reach consumers silently.

---

## 🟡 Warnings

### Performance

- **No prepared-statement cache** (`worker.ts:169`). `sqlite.statements(db, sql)` re-parses and
  re-plans on *every* call. Typically the single largest available win (2–10× on simple statements).
  Worst for `bulkWrite`, whose ~32k-placeholder INSERT template is re-parsed on every flush.
- **`stream()` has no back-pressure** (`worker.ts:208-228`). The worker posts chunks as fast as
  SQLite produces them, never waiting for the consumer. A slow consumer means cloned chunks pile up
  unbounded in the message queue — the same memory blow-up the README promises to avoid, just
  relocated. Needs a credit/ack scheme.
- **No default PRAGMAs.** `pragmas` defaults to `{}`, so consumers who don't copy the README example
  silently run on `journal_mode=DELETE` + `synchronous=FULL` — often an order of magnitude of write
  throughput on OPFS. Ship `WAL` + `NORMAL` (+ `busy_timeout`, see below) as defaults.
- **PRAGMAs are re-applied on every query** (`worker.ts:171` prepends `allQueryPragmas` to each
  statement) — contradicting both the JSDoc and the README, which say "applied on open".
- **`bulkWrite` flushes are separate transactions.** ~300 independent commits for a 1M-row load;
  wrap the whole lifetime in one `BEGIN`/`COMMIT`.
- **Every worker compiles its own WASM copy** (`worker.ts:118`). The default VFS's binary is 1.23 MB;
  cost scales linearly with `poolSize`. A `WebAssembly.Module` is structured-cloneable — compile once,
  `postMessage` it, instantiate per worker.
- **Scheduling is lowest-index-first with sticky writer** (`client.ts:488-505`). Reads preferentially
  land on worker 0, which also tends to be the writer, so writes queue behind reads while other
  workers sit idle; and `currentWriterIndex` is only cleared when a reader happens to be queued at
  release time. Sustained writes can starve reads (`releaseWorker` always drains the writer queue
  first). Use round-robin/LRU and prefer non-writer workers for reads.
- **Per-row `Object.fromEntries(cols.map(...))`** (`worker.ts:188`) allocates an intermediate pairs
  array per row in the hottest loop; a plain `for` loop is measurably cheaper.

### Robustness & correctness

- **`isWriteQuery()` is a regex over raw SQL** (`utils.ts:24`) called independently at four call
  sites. It misses `VACUUM`, `ALTER`, `ANALYZE`, `REINDEX`, `SAVEPOINT`, manual `BEGIN`/`COMMIT` —
  which then route to the *read* pool and run concurrently against the same file. It also
  misclassifies `SELECT … WHERE msg = 'DROP TABLE attempted'` as a write. **`write()` should route to
  the writer unconditionally** (it declares intent by name); reserve sniffing for `read()`/`stream()`,
  and have `read()` reject a write instead of silently executing it and dropping the affected count.
- **No `busy_timeout` and no `SQLITE_BUSY` retry.** Each pool worker opens its own connection to the
  same file; legitimate lock collisions surface as raw errors.
- **`sqlite.close(db)` is never called.** `close()` goes straight to `worker.terminate()`, giving
  SQLite/the VFS no clean-shutdown path — OPFS handles and WAL state are left to crash recovery.
- **A failed rollback masks the original commit error** (`client.ts:968-971`).
- **Multi-tab is entirely uncoordinated and undocumented.** `currentWriterIndex` and both queues are
  per-JS-realm; two tabs on the same OPFS file each enforce their own "single writer". No
  `navigator.locks`, no `BroadcastChannel` anywhere. Either implement Web Locks-based coordination or
  document it as unsupported.
- **`output().enqueue` produces one unhandled rejection per row** if table creation fails.
- **Queued pre-ready requests wait for the *slowest* worker**, since queues are only drained by the
  `Promise.all`-gated bootstrap rather than per-worker on `ready`.

### Architecture & types

- **`client.ts` is a 1016-line god module** (a 736-line factory closure) mixing worker lifecycle,
  pool scheduling, query dispatch, bulk ETL and transactions. The scheduler is the most
  concurrency-sensitive code in the library and, being trapped in the closure, is only reachable
  through slow browser tests — which is why B1 survived. Split into `pool` / `scheduler` /
  `queries` / `transaction` / `bulkOperations`, with the scheduler parameterized over a minimal
  `{ available: boolean }` shape so it is unit-testable in Node with fakes.
- **`output()` doesn't belong in a database client.** Schema DSL + drop/recreate/populate + index
  management is ETL/migration territory, and it will collide with any migration or query-builder
  layer added later. Keep the core at `read/write/one/stream/transaction/close` (+ `bulkWrite`
  as a thin batching helper) and put schema utilities in an optional module on top.
- **`SQLiteDB` is a hand-maintained duplicate that has already drifted** and is never enforced
  (`transaction`'s callback is typed `(db: any)` there vs. the real `TransactionDB`; `params?: any[]`
  vs. the real `unknown[]`). Since the return type isn't annotated, the *shipped* `.d.ts` is raw
  structural inference referencing internal, non-exported types — `TransactionDB`, `Schema`,
  `Index`, `OutputOptions` are all unnameable by consumers. Export them and add
  `satisfies SQLiteDB`, or delete `SQLiteDB`.
- **`SQLiteVFS` is used in a public option but never exported** from the package.
- **`types.ts:1-38` is a dead, stale second protocol description** (with a `SQLiteCLientCallParams`
  typo) that disagrees with the live one on field names (`flag`/`workerIndex` vs `flags`/`index`) —
  in the one file whose job is to be the canonical wire contract.
- **No exhaustiveness checks on the message unions.** Neither dispatch point has a
  `default: const _x: never = data` guard, so adding a protocol variant silently no-ops.
- **`read<T>`/`one<T>`/`stream<T>` are phantom types** enforced by an explicit `as T[]` cast with zero
  runtime validation — and the JSDoc never says so. Document it as caller-asserted, and/or default to
  `unknown`, and/or offer an optional `parse` hook.
- **`wa-sqlite.d.ts` shadows wa-sqlite's own shipped types.** v1.0.9 *does* ship a complete
  `SQLiteAPI` interface; the deep import `wa-sqlite/src/sqlite-api.js` bypasses its `types` field,
  forcing a hand-written 7-method subset that is **missing `close`** — plausibly the reason
  `sqlite.close()` is never called. Import the bare specifier `'wa-sqlite'` (same runtime file) and
  keep ambient declarations only for the genuinely untyped deep imports.
- **`TransactionDB` methods take `...args: any[]`**, losing all parameter typing inside transaction
  callbacks — a regression versus the top-level methods, on a public API surface.
- **~45 `any` in `src/`**, tolerated only because `biome.json` locally disables `noExplicitAny` and
  `noBannedTypes`. Most are `unknown` in disguise (`sqlParams`, `formatValue`, `bulkWrite`'s row
  records) and cost nothing to tighten.
- **`tsconfig.json` enables only `strict`.** Turning on `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` would surface real gaps — `debug.ts`'s dozens of raw `sql[i]` char
  accesses (lines 12-58) and `worker.ts:190`'s `row[i]` both assume always-defined indices.

### Best practices

- **The `SharedArrayBuffer` / COOP+COEP requirement is self-imposed and avoidable.** The SAB is used
  for exactly two things: a busy-wait init mutex and the `ABORTING` flag polled in the step loop.
  Neither needs shared memory — `navigator.locks.request()` works in workers, and since
  `sqlite.step()` is async, a `postMessage`-driven local boolean does the same job. Dropping the SAB
  removes cross-origin isolation as a hard requirement on **every consuming app**, which is a heavy
  tax (COEP blocks any cross-origin subresource lacking CORP/CORS — a third-party widget added later
  breaks silently). *This is the single highest-leverage architectural decision available.*
- **`Buffer.isBuffer` in browser code** (`debug.ts:76`) — `Buffer` doesn't exist in a browser and no
  polyfill is configured; it throws `ReferenceError` the first time that branch runs. It passes today
  only because the test exercising it runs in the Node `unit` project. `value instanceof Uint8Array`
  already covers the real case.
- **`defer()` from `@lalex/promises` duplicates native `Promise.withResolvers()`** (stable ES2024,
  available in every browser that supports OPFS). Dropping it removes a dependency from the hot path.
- **Worker resolution is an unverified bundler assumption.** `new Worker(new URL('./worker.ts',
  import.meta.url))` requires the *consumer's* bundler to compile a `.ts` file reached through
  `node_modules`; the `exports` map ships no worker entry and the build produces no worker artifact.
  Either ship a prebuilt worker entry (more portable) or add a packaging test against a non-Rsbuild
  consumer.
- Missing `sideEffects: false` and `engines`; the release action is pinned to a mutable `@v1` tag
  while holding `NPM_TOKEN`; the inline Rsbuild plugin uses the reserved `rsbuild:` name prefix and
  an ad-hoc `api` type instead of `RsbuildPlugin` from `@rsbuild/core`.
- **wa-sqlite vs `@sqlite.org/sqlite-wasm`** — a real decision, not a reflex. wa-sqlite gives more VFS
  variety and the low-level API this design is built on, but is single-maintainer and unpublished to
  npm. The official build is npm-published and SQLite-team-maintained, and its OPFS SAHPool VFS also
  avoids SAB — but it is single-connection, so it does not hand you this library's concurrent-read
  pool for free.

### Readability

- 4-level nested ternary normalizing the index spec (`client.ts:870`) — extract a named helper.
- `sqlite.step()` treats every non-`SQLITE_ROW` result as success without a comment stating the
  wa-sqlite invariant that makes it safe (`worker.ts:184`).
- `SQLiteQueryOptions.id` is documented on four methods and never implemented.
- `SQLiteQueryOptions<_T>` declares a generic parameter it never uses.
- Leftover placeholder `status: 'HAHA'` (`debug.ts:158`); typo `'Cannot werite in read-only
  transaction'` (`client.ts:920`) — visible to consumers.
- `sqlParams`/`addParam` (`utils.ts`) are exported and unit-tested but **never used by the library**;
  their 3-digit padding is duplicated as a magic assumption in `debug.ts`'s parser.
- `pool.find((w) => { if (w.available) return true; return false; })` (`client.ts:497`).
- Two explicit return-type annotations (`debug.ts:63`, `client.ts:407`) where inference suffices.

---

## Suggested order of work

1. **Decide the two foundations first** — they change everything downstream: (a) wa-sqlite vs
   `@sqlite.org/sqlite-wasm`; (b) drop `SharedArrayBuffer` for Web Locks + `postMessage`, removing
   the COOP/COEP requirement.
2. **Extract the scheduler as a pure, unit-testable module** with a single owner of `available`.
   B1 is a design defect that decomposition prevents rather than patches.
3. **Make failure paths total**: `onerror`, timeouts, `open-error`, a `close` handshake that settles
   in-flight work and calls `sqlite.close()`.
4. **Shrink the core surface** to `read/write/one/stream/transaction/close`; move `output()` (and its
   schema DSL) to an optional layer built on the primitives.
5. **Then** the performance work — prepared-statement cache, back-pressure, default pragmas, shared
   `WebAssembly.Module` — with the debug instrumentation actually wired so the gains are measurable.
6. **Cover the stateful methods with tests before calling them stable**, put `tests/` in the tsc
   program, and move the suite into CI rather than a bypassable pre-commit hook.

---

*Review generated by the review-codebase skill*
*Scope: `browser-sqlite` — 20 files — 9 axes*
