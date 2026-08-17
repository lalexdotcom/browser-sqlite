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
| B5 | open | Data loss. `bulkWrite.flush()` chains batches on a shared `writePromise`; after one rejection every later `.then` is skipped but the rows were already spliced out — batches silently dropped. `output()` runs DROP / CREATE / insert / CREATE INDEX as separate un-transacted writes — a failure between DROP and CREATE loses the table. **Fix shape decided (D3, `mem:resume-plan` §1.1): staging table + atomic rename, not a wrapping transaction.** `bulkWrite` keeps its un-transacted batches; only the final swap is transactional. | `client.ts:780-791`, `:815-894` |
| B7 | **done** | Wave 0, 2026-08-17. `.github/workflows/ci.yaml` runs biome + tsc + build + the full suite on push/PR; `tests/` added to the tsc `include`; characterization suites added for `transaction()` (`tests/browser/transaction.test.ts`), `bulkWrite()` (`bulk-write.test.ts`), `output()` (`output.test.ts`) and the `AccessHandlePoolVFS` + `poolSize` guard (`vfs.test.ts`); both unfalsifiable abort assertions in `concurrency.test.ts` fixed. 81 → **105 tests, all green**. | `tests/`, `tsconfig.json`, `.github/workflows/ci.yaml` |
| B9 | open | **Found by wave 0.** An `AbortSignal` **already aborted** when `stream()` is called is ignored entirely — the stream runs to completion and delivers every chunk. `signal.addEventListener('abort')` never fires for an already-aborted signal and nothing checks `signal.aborted` up front. Masked until now by the unfalsifiable `chunkCount <= 3` assertion. Fix alongside the `stream()` abort work in wave 1. | `client.ts` `stream()`; test: `concurrency.test.ts` `it.fails('an already-aborted AbortSignal…')` |
| B10 | open | **The published package cannot be consumed at all.** `dist/esm/index.js` contains `new Worker(new URL('./worker.ts', import.meta.url), …)` while `dist/esm/` holds only `index.js` and the `.d.ts` files — no worker artifact, no `src/` (`files: ["dist"]`), no `worker` entry in `exports`. Reproduced end to end by `pnpm test:consumer` (2026-08-17): `vite build` fails with `[commonjs--resolver] Could not resolve entry module "node_modules/browser-sqlite/dist/esm/worker.ts"`, and the Vite **dev** server hangs forever instead — `requestfailed … worker.ts?worker_file (net::ERR_BLOCKED_BY_RESPONSE)` and the page never settles, which is **B2 demonstrated**: a worker that fails to load hangs the caller with no error. This is the only item where the library does not work at all rather than works imperfectly. **Pulled to the front as wave P (user, 2026-08-17) — it is now the next thing we do, ahead of every correctness wave. Same piece of work as B8; see `mem:resume-plan` §2.1.** | `rslib.config.ts`, `package.json` `exports`, `client.ts` worker construction |
| B8 | open | `wa-sqlite` ships as a raw GitHub dependency → travels into every consumer lockfile, breaks registry-proxied installs, no provenance. Blocking **for publishing**, not for functioning. Fix: vendor prebuilt WASM+glue at build time. | `package.json` |

## Important — fix before calling the API stable

| ID | Status | Issue | Where |
|---|---|---|---|
| B4 | open | Unescaped identifier interpolation in `bulkWrite` / `output` / pragmas, and wa-sqlite's `statements()` executes `;`-separated statements → real stacked-query injection. Trust boundary is the app developer, not the end user, but the fix is cheap: one shared `quoteIdent()` + a pragma-key allowlist. | `client.ts:785`, `:837-886`, `worker.ts:110` |
| B6 | open | `{} as ReturnType<typeof createClientDebug>` — `createClientDebug` is `import type` only and never called, so all 221 lines of `debug.ts` are unreachable and the public `db.debug` type claims a shape that is always `undefined`. Also blocks measuring any perf work. **Decided (D5, `mem:resume-plan` §1.3): wire it behind `debug?: string \| boolean`.** Smaller than it looks — the instrumentation call sites already exist in `client.ts`, optional-chained into no-ops (`:347`, `:365`, `:374`, `:385`, `:416-417`, `:544`). The work is replacing the cast with a real conditional `createClientDebug(...)`, plus four fixes listed in §1.3 (the unbounded `worker.requests` array is the blocking one). Those call sites have never executed — types align but runtime behaviour is unverified. | `client.ts:302-307`, all of `debug.ts` |
| W-route | open | `isWriteQuery()` is a regex over raw SQL, called at 4 sites; misses `VACUUM`/`ALTER`/`ANALYZE`/`REINDEX`/`SAVEPOINT`/manual `BEGIN` (they route to the *read* pool) and misclassifies string literals. `write()` should route to the writer unconditionally; `read()` should reject a write instead of silently running it. | `utils.ts:24` |
| W-multitab | open | Multi-tab is entirely uncoordinated and undocumented — `currentWriterIndex` and both queues are per-realm; two tabs each enforce their own "single writer". No `navigator.locks`, no `BroadcastChannel`. Implement or document as unsupported. **Partly settled: `output()` must be multi-tab safe (D3, user requirement) — its staging sweep is `navigator.locks`-guarded in wave 3. That brings the locks primitive into the codebase; the rest of the client stays uncoordinated until this item is done.** | `client.ts` |
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

- ~~`Buffer.isBuffer` in browser code (`debug.ts:76`)~~ — **done 2026-08-17.** Now `value instanceof Uint8Array` (a Node Buffer is a subclass, so the unit test still passes) with a manual hex conversion. Surfaced as a compile error once `tsconfig.build.json` scoped the build program to `src`, which stopped pulling Node types in transitively through the test/config files.
- `defer()` from `@lalex/promises` duplicates native `Promise.withResolvers()` — drop the dep.
- ~~Worker resolution is an unverified bundler assumption~~ — **verified broken 2026-08-17, promoted to B10.**
- `wa-sqlite.d.ts` shadows wa-sqlite's own shipped types via a deep import; import the bare specifier instead.
- `types.ts:1-38` dead/stale protocol duplicate (with a `SQLiteCLientCallParams` typo).
- `SQLiteStreamOptions` (`client.ts:65-68`) is `SQLiteQueryOptions<T> & { signal?: AbortSignal }` — but `signal` is already in `SQLiteQueryOptions`. The intersection is a no-op type; delete it or give it real content.
- `worker.requests` (`debug.ts`) grows without bound — `MAX_QUERY_HISTORY_LENGTH` caps only `currentRequest.queries`. Blocks D5; see `mem:resume-plan` §1.3.
- **[wave 1]** The JSDoc of `CreateSQLiteClientOptions.name` (`client.ts:25-28`) is wrong and self-contradictory: it claims the option is the OPFS database file name, but the file comes from the positional `file` argument — `name` only feeds `clientPrefix` (`client.ts:286`), which names the Web Workers via `WorkerOptions.name` and will feed the debug prefix. Its own `@defaultValue` line describes the prefix behaviour and contradicts the two lines above it.
- No exhaustiveness (`default: const _x: never`) on either message-union dispatch.
- `read<T>`/`one<T>`/`stream<T>` are phantom types (`as T[]`, no validation) and the JSDoc never says so.
- ~45 `any` in `src/`; `tsconfig` could enable `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- Missing `sideEffects: false` and `engines`; release action pinned to a mutable `@v1` tag while holding `NPM_TOKEN`; inline rsbuild plugin uses the reserved `rsbuild:` name prefix and an ad-hoc `api` type.
- Leftovers visible to consumers: `status: 'HAHA'` (`debug.ts:158`), typo `'Cannot werite in read-only transaction'` (`client.ts:920`), `SQLiteQueryOptions.id` documented on 4 methods and never implemented, unused generic `SQLiteQueryOptions<_T>`, 4-level nested ternary (`client.ts:870`), `pool.find((w) => { if (w.available) return true; return false; })` (`client.ts:497`).

## Characterization-test convention (from wave 0)

Known bugs are pinned with `it.fails(...)` — the test asserts the *correct* behaviour
and `.fails` asserts the bug is still there. **When the bug is fixed the test starts
passing, which makes `it.fails` fail** — that red is the signal to drop `.fails`, not a
regression. Currently pinned: B1 (`transaction.test.ts`), B9 (`concurrency.test.ts`).

Behaviour that is wrong but not yet pinned is documented with a plain `it` plus a
comment naming the issue ID — e.g. B5's silent batch drop in `bulk-write.test.ts`.
Those tests will break when the bug is fixed; that is intended.

Context: `mem:project-state`. Sequencing: `mem:resume-plan`.
