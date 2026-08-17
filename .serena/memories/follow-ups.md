# Follow-ups — open issues

Source: `docs/reviews/2026-08-17-0759-browser-sqlite.md` (2026-08-17), re-triaged.
IDs `B*` match the review. Severity here is **our** grading, not the review's — the
review marked all 9 axes BLOCKING, which discriminates nothing.

Status legend: `open` / `in-progress` / `done` / `wontfix`. Keep this column current.
Line numbers are from the 2026-08-17 snapshot — re-locate symbols with Serena before editing.

## Blocking — must fix before any stable release

| ID | Status | Issue | Where |
|---|---|---|---|
| B1 | open | `worker.query()`'s `finally` republishes `available` per-statement, so `transaction()` loses exclusivity and a concurrent `read`/`write` can execute *inside* the open transaction. `stream()` early `break` also frees a worker still calling `sqlite.step()`. **Verified in source.** Fix: single owner of `available` (`releaseWorker`), explicit pinned/held flag checked by `acquireWorker`, and an internal AbortController for `stream()` acked by the worker. | `client.ts:452-456` vs `client.ts:554-578`; `stream()` |
| B2 | open | No `onerror`, no `onmessageerror`, no request timeout anywhere → a worker crash hangs the caller forever; if it was the writer, **every future write deadlocks**. Also `open()`'s unconditional `.finally()` posts `ready` even on a failed open (masks the multi-tab exclusive-lock failure), and the error reply posts `e.cause` uncloneable-unsafe. | `client.ts:326-474`, `worker.ts:141`, `:153`, `:236` |
| B3 | open | `close()` only calls `worker.terminate()`: in-flight deferreds are never settled and both request queues are never drained → permanent hangs. Post-close queries queue onto a queue nothing drains. Also `sqlite.close(db)` is never called at all. | `client.ts:981-987` |
| B5 | open | Data loss. `bulkWrite.flush()` chains batches on a shared `writePromise`; after one rejection every later `.then` is skipped but the rows were already spliced out — batches silently dropped. `output()` runs DROP / CREATE / insert / CREATE INDEX as separate un-transacted writes — a failure between DROP and CREATE loses the table. | `client.ts:780-791`, `:815-894` |
| B7 | open | `transaction()`, `bulkWrite()`, `output()` have **zero** test coverage, as does the `AccessHandlePoolVFS` + `poolSize > 1` guard. No CI runs the suite. `tests/` is outside the tsc program. Several existing assertions cannot fail (e.g. `concurrency.test.ts:167` asserts `chunkCount <= 3` on a 3-row table). | `tests/`, `tsconfig.json`, `.github/workflows/` |
| B8 | open | `wa-sqlite` ships as a raw GitHub dependency → travels into every consumer lockfile, breaks registry-proxied installs, no provenance. Blocking **for publishing**, not for functioning. Fix: vendor prebuilt WASM+glue at build time. | `package.json` |

## Important — fix before calling the API stable

| ID | Status | Issue | Where |
|---|---|---|---|
| B4 | open | Unescaped identifier interpolation in `bulkWrite` / `output` / pragmas, and wa-sqlite's `statements()` executes `;`-separated statements → real stacked-query injection. Trust boundary is the app developer, not the end user, but the fix is cheap: one shared `quoteIdent()` + a pragma-key allowlist. | `client.ts:785`, `:837-886`, `worker.ts:110` |
| B6 | open | `{} as ReturnType<typeof createClientDebug>` — `createClientDebug` is `import type` only and never called, so all 221 lines of `debug.ts` are unreachable and the public `db.debug` type claims a shape that is always `undefined`. Also blocks measuring any perf work. Fix: wire it behind a real `debug?: boolean` option, or delete the subsystem. | `client.ts:302-307`, all of `debug.ts` |
| W-route | open | `isWriteQuery()` is a regex over raw SQL, called at 4 sites; misses `VACUUM`/`ALTER`/`ANALYZE`/`REINDEX`/`SAVEPOINT`/manual `BEGIN` (they route to the *read* pool) and misclassifies string literals. `write()` should route to the writer unconditionally; `read()` should reject a write instead of silently running it. | `utils.ts:24` |
| W-multitab | open | Multi-tab is entirely uncoordinated and undocumented — `currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single writer". No `navigator.locks`, no `BroadcastChannel`. Implement or document as unsupported. | `client.ts` |
| W-types | open | `SQLiteDB` is a hand-maintained duplicate that has already drifted and is never enforced; the shipped `.d.ts` therefore leaks unnameable internal types (`TransactionDB`, `Schema`, `Index`, `OutputOptions`). `SQLiteVFS` used in a public option but never exported. `TransactionDB` methods take `...args: any[]`. | `client.ts`, `types.ts` |
| W-arch | open | `client.ts` is a 1016-line god module (736-line factory closure) — the scheduler is trapped in the closure and only reachable through slow browser tests, which is *why* B1 survived. Split into `pool` / `scheduler` / `queries` / `transaction` / `bulkOperations`. `output()` should move to an optional layer on top of the primitives (breaking change). | `client.ts` |
| W-sab | open | The `SharedArrayBuffer` / COOP+COEP requirement is self-imposed: the SAB serves only the init mutex and the `ABORTING` flag. `navigator.locks` + a `postMessage`-driven boolean replace both, removing cross-origin isolation as a hard requirement on every consuming app. Highest leverage per line changed. | `orchestrator.ts`, `worker.ts`, `client.ts` |

## Performance — after correctness, with debug instrumentation live

- No prepared-statement cache (`worker.ts:169`) — typically the largest single win (2-10×); worst for `bulkWrite`'s ~32k-placeholder template.
- `stream()` has no back-pressure (`worker.ts:208-228`) — chunks pile up unbounded, defeating the README's own memory guarantee. Needs a credit/ack scheme.
- No default PRAGMAs → consumers silently run `journal_mode=DELETE` + `synchronous=FULL`. Ship WAL + NORMAL + `busy_timeout`.
- PRAGMAs are re-applied on **every** query (`worker.ts:171`), contradicting the JSDoc and README which say "applied on open".
- `bulkWrite` flushes are separate transactions (~300 commits for 1M rows).
- Every worker compiles its own WASM copy (`worker.ts:118`, 1.23 MB × poolSize). `WebAssembly.Module` is structured-cloneable — compile once, `postMessage` it.
- Scheduling is lowest-index-first with a sticky writer (`client.ts:488-505`) → reads pile on worker 0 which is usually also the writer; sustained writes can starve reads. Use round-robin/LRU, prefer non-writer workers for reads.
- Per-row `Object.fromEntries(cols.map(...))` in the hottest loop (`worker.ts:188`).

## Cleanups — cheap, batch them opportunistically

- `Buffer.isBuffer` in browser code (`debug.ts:76`) — throws `ReferenceError`; passes today only because that test runs in the Node project. Use `instanceof Uint8Array`.
- `defer()` from `@lalex/promises` duplicates native `Promise.withResolvers()` — drop the dep.
- Worker resolution (`new Worker(new URL('./worker.ts', import.meta.url))`) is an unverified bundler assumption; no worker entry in `exports`, no worker artifact built.
- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via a deep import; import the bare specifier instead.
- `types.ts:1-38` dead/stale protocol duplicate (with a `SQLiteCLientCallParams` typo).
- No exhaustiveness (`default: const _x: never`) on either message-union dispatch.
- `read<T>`/`one<T>`/`stream<T>` are phantom types (`as T[]`, no validation) and the JSDoc never says so.
- ~45 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Missing `sideEffects: false` and `engines`; release action pinned to a mutable `@v1` tag while holding `NPM_TOKEN`; inline rsbuild plugin uses the reserved `rsbuild:` name prefix and an ad-hoc `api` type.
- Leftovers visible to consumers: `status: 'HAHA'` (`debug.ts:158`), typo `'Cannot werite in read-only transaction'` (`client.ts:920`), `SQLiteQueryOptions.id` documented on 4 methods and never implemented, unused generic `SQLiteQueryOptions<_T>`, 4-level nested ternary (`client.ts:870`), `pool.find((w) => { if (w.available) return true; return false; })` (`client.ts:497`).

Context: `mem:project-state`. Sequencing: `mem:resume-plan`.
