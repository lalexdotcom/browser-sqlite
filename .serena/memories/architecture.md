# Architecture — what the code is

`browser-sqlite`: persistent SQLite in the browser — wa-sqlite (WASM) + a Web Worker
pool + an OPFS/IndexedDB VFS. **Concurrency model: concurrent reads across the pool,
writes serialized through one designated writer worker — and, since rc.5, serialized again
across every client and tab by an origin-wide Web Lock.** That model is sound and is the
thing worth preserving.

Stack, build output and test tooling: `mem:stack-and-build`. VFS: `mem:vfs`.

## Layout — line counts verified 2026-08-28 (post `feat/statement-cache`); `const/` and `types/` since 2026-09-24

**Placement rule (user, 2026-09-16): a type derived from a const lives in the same file as the const.** Inside `const/`, cross-file imports are `import type` only: `pnpm docs:vfs` and `pnpm test:matrix` load these files under plain Node type stripping, which cannot resolve an extensionless value import. No `index.ts` in either directory, no re-export.

| File | Lines | Role |
|---|---|---|
| `api.ts` | 318 | **The public type layer, and the only module `index.ts` re-exports wholesale.** `SQLiteQueryAPI` is the querying surface; `SQLiteDB` and `SQLiteTransactionDB` are it plus their own extras. Everything here is public by construction, which is what stops the leak that made `SQLiteQueryOptions` and `TransactionDB` unnameable — a hand-kept name list is what you forget to update. |
| `client.ts` | ~1050 | **Assembly only**: options, validation, wiring, the public `SQLiteDB` surface, `close()`. Holds `DEFAULT_POOL_SIZE = 2`, `DEFAULT_STATEMENT_CACHE_SIZE = 32` and `DEFAULT_STATEMENT_CACHE_BYTES = 8 MiB`, the vfs/build guard, `applyBarrier` and `acquireInstrumented` — **the single choke point through which every read, write, transaction and bulk acquires a lease**, which is what makes the barrier one wrapper rather than six. **All four read entry points (`read`, `first`, `chunk`, `stream`) now go through `readWithRetry` / `streamWithRetry`**, which re-issue once on a `BUSY` that carries a `sqliteCode` — see below. Line numbers deliberately omitted: they rotted every time they were cited. |
| `capabilities.ts` | 144 | `detectFeatures` / `missingFeature` / `defaultBuildFor` / `describeMissing`, `UNPROBEABLE`. Public: `detectFeatures` and `missingFeature`. `defaultBuildFor(vfs, available)` is the first declared build whose requirements `available` meets — pure, so tests pass a set; the client and `deleteDatabase` pass `detectFeatures()`, and the worker never resolves (`build` is required on `open` and `delete`). It lives here, not in `const/vfs.ts`, because it reads `BUILD_CAPABILITIES` as a value. |
| `const/platform.ts` | — | `PlatformFeature`, the base of the declaration DAG (platform ← builds ← vfs ← protocol). |
| `const/builds.ts` | — | `BUILD_CAPABILITIES` — the build registry, `{ requires, interruptibleWithout }` per build — and `SQLiteBuild`, derived from its keys. `WA_SQLITE_BUILDS` (worker) and `BUILD_NOTE` (VFS.md generator) are typed against `SQLiteBuild`, so they are checked against the registry both ways. Preference order is NOT here: it is each VFS's `builds` array. |
| `const/vfs.ts` | — | **`VFS_CAPABILITIES` — the single source of truth** the client guard, the conformance suite, the VFS.md generator and the benchmark page all read — the page through `scripts/bench/assemble.ts`, which writes it beside the page since the table is no longer exported — with `SQLiteVFS` derived from its keys, `VFSCapability`/`VFSStorage`/`VFSMemoryModel`, `folderOf`. `builds` is one preference order for every VFS: `sync`, `jspi`, `async`. |
| `const/sqlite.ts` | — | `SQLITE_CODES` (31 primary) and `SQLITE_EXTENDED_CODES` (82 extended) with their types, transcribed from SQLite 3.53.0's `sqlite.h.in`. **Re-transcribe when wa-sqlite moves to another SQLite**: `tests/unit/sqlite-codes.test.ts` checks the names wa-sqlite also defines, and cannot see a code it lacks. |
| `types/errors.ts` | — | `SQLiteError extends Error` with `code` and `name` mirroring it, plus `SQLiteBulkWriteError`. `sqliteCode?: SQLiteResultCode` — strict, a primary code — and `sqliteExtendedCode?: SQLiteExtendedResultCode \| (number & {})` — open, because a wrong read must stay representable (spec 2026-09-14, D9/D10). The union in the file is the list of codes; since 2026-09-15 `STATEMENT_FAILED` is every statement SQLite refuses other than a lock conflict. |
| `types/protocol.ts` | — | The wire protocol: `ClientMessageData`, `WorkerMessageData`, `SQLiteWorkerMessageData`, `SQLWorkerResultData`, `SavepointOp`, `SQLOptions`, `WasmLocation`. **Internal because nothing exports it** — `index.ts` has no line for this file. |
| `scheduler.ts` | 366 | **Pure** — availability (a private `Set`), both wait queues, writer designation, opaque leases, `remove(index)`, `shutdown(reason)`, per-index generation counter. No `Worker`, no DOM. **This purity is load-bearing: B1 survived for months because the scheduler was only reachable through slow browser tests.** |
| `pool.ts` | 509 | Worker creation and transport: `postMessage`/`onmessage` routed by `callId`, the raw query generator, the stop-and-drain that waits for the worker's in-flight `done` before a lease returns, `onerror`/`messageerror`, the `close` handshake, the per-worker `status` field. |
| `supervisor.ts` | 94 | Pure per-slot restart policy, zero imports. A slot holds a worker **from `spawned`, not from `ready`** — that is SUP-1's fix. Restart counter resets on a request actually served; eviction leaving no live slot fails the client; `evicted` is permanent against a late `ready`. |
| `queries.ts` | 167 | `chunk()` — the single query primitive and **the only place an `AbortSignal` is read** — plus `streamRows`/`readWorker`/`firstWorker`/`writeWorker` and `makeAbortRace`. |
| `transaction.ts` | 200 | `transaction()` over a single lease held for its whole lifetime. Evicts a worker whose fallback `ROLLBACK` failed. |
| `savepoints.ts` | — | **Pure** — the savepoint-stack copy and its decision table, unit-tested in Node. `release()` and `rollback()` on a handle are decided against the stack; a method on a closed handle resolves when what it promises is already true and rejects with `SAVEPOINT_CLOSED` otherwise, and `rollback({ release: false })` on a savepoint already rolled back and closed rejects with `SAVEPOINT_CLOSED`. |
| `bulk.ts` | 334 | `bulkWrite()` + `output()`. Calls the **public** `write` — one lease per batch, worker released between batches. Do not consolidate it into one held lease; multi-tab safety depends on it. |
| `credits.ts` | 94 | The pure credit gate. `createCreditGate(tick)`, `createMessageChannelTick`, `DEFAULT_CREDIT_WINDOW = 2`. |
| `epochs.ts` | — | The barrier's state. The realm-wide symbol registry (`Symbol.for('browser-sqlite.epochs.v1')`) is still there and every client in a tab shares it — but since rc.5 it is a **floor**, not the authority: `originMax()` reads `max(n)` over held `bsq:epoch:<ns>:<file>:<n>` lock names and `raiseTo` can only lift the cell. **`Symbol.for` is shared across realms; `globalThis` is not** — measured, and that is where the per-realm separation actually comes from, not from the symbol. `current`/`bump`/`raiseTo` are synchronous and must stay so; only `originMax`/`publish` are async. |
| `debug.ts` | 345 | The `db.debug` tree, public since 2026-09-30 and outside semver (`API.md`). The only writer of the tree: `client.ts` and `pool.ts` hold handles (`RequestDebugHandle` from `acquireInstrumented`, `WorkerDebugHandle` per spawned worker, whose `query()` binds a query to that worker's generation). One pool-level `requests` list bounded at `poolSize × DEBUG_REQUESTS_PER_WORKER` (50) evicting only ended entries; 50 queries per request. No Proxy: `status` and `queue` are getters, so the tree survives `structuredClone`. The slot's active request lives outside the published tree. The library's own statements — the barrier, a transaction's BEGIN/COMMIT/ROLLBACK — reach it with the pool query option `internal: true` (`transaction.ts`'s `exec` wraps the worker in a facade for that) and are recorded with `internal: true`, out of the request's `rows`/`affected`. |
| `logger.ts` | 30 | `createLogger(prefix, enabled, sink = console)`. **Lifecycle events only** — never per query. Disabled, it returns three no-op closures allocated once. |
| `locks.ts` | — | Web Locks wrapper + the pure sweep decision + **every lock name this library takes**. `createLocks`, `noOpLocks` (use this in tests — `createLocks(undefined)` falls back to the real API and **Node 24 ships one**), `hold(name, { mode, signal })`, `sharesStorage`, `initLockName(vfs, file)`/`writeLockName(vfs, file)`, `stagingTableName`/`stagingLockName`/`sweepLockName(vfs, file)`, `staleStagingTables`, and since 2026-09-03 `clientMarkerName`/`parseClientMarker` plus `entries()` (held AND pending, each with `mode` and `clientId` — `heldNames()` is untouched, `epochsFor` needs nothing else). **Every lock name is `bsq:<kind>:<VFS name>:<path>` since 2026-09-23** — `namespaceFor` is gone, because each VFS keeps its own files (§ "Two names per database" below). **`bsq:staging` alone stays keyed on the path without the VFS, deliberately**: its table name is a UUID, and it is a liveness marker the sweep reads, so renaming it would let a new tab's sweep drop a live staging table held by an older tab during a deploy. For the five VFS without a folder every name but `bsq:sweep` is byte-identical to rc.5 — pinned by `tests/unit/locks.test.ts`. |
| `inspect.ts` | 218 | Database inspection: `inspectDatabase(file, { vfs })`, `db.inspect()`'s engine `inspectWith`, and `resolveRealmId`. **Nothing here sits on a query path.** One `locks.entries()` supplies the roster, the writing tab and the queue, so all three describe one instant — two calls would describe a state that never coexisted. `resolveRealmId` memoises the realm's own `clientId` at MODULE scope, not on `globalThis`: an iframe gets its own module instance and its own id, and that separation is the whole basis of `sameTab`. No API returns your own `clientId`, so it is read back by holding a uniquely named nonce and finding it in the registry — paid once per realm, ever, and not even once when a marker of ours is already in the snapshot. |
| `utils.ts` | 205 | `isReadQuery`/`isWriteQuery` + `assertReadable` + `quoteIdent`/`renderPragmas` + `sqlParams`/`addParam`, and since 2026-09-23 database identity: `normalizeDatabaseFile`, `databasePath`, `databaseFiles`, `DATABASE_FILE_SUFFIXES`, `MAX_DATABASE_PATH`, `resolveDatabase`. |
| `worker/worker.ts` | 700 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Holds `VFSConfigs` and `WA_SQLITE_BUILDS`. **Constructs every VFS with `{ lockPolicy: 'shared' }` (`:159`).** `ready` only on success, `open-error` on failure; every `cause` structured-clone-probed; exhaustive message dispatch. |
| `worker/statement-cache.ts` | 85 | **Pure** — a per-worker LRU of prepared statements keyed by the exact SQL string. Prepares nothing, finalises nothing, imports nothing: `set`/`markUncacheable` return the handles their insertion evicted and `worker.ts` finalises them, so no handle can be dropped by omission. Unit-tested in Node against plain integers. |
| `worker/sqlite-code.ts` | — | **Pure** — `sqliteCodeOf(e)`: SQLite's result code only for wa-sqlite's own `SQLiteError`, else `undefined`. Every `sqliteCode` the worker sends goes through it: a DOMException's legacy `code` (SecurityError 18) would otherwise pass for SQLite's `TOOBIG`. Unit-tested in Node. |
| `index.ts` | — | Re-exports. `const/*` by name; `export *` only for `api`, `client`, `delete` and `types/errors`. Nothing from `types/protocol`. |

**The read path retries once, and the discriminator is `sqliteCode` (2026-09-03).** A `BUSY`
that SQLite itself reported carries a numeric code; the ones this library mints to mean "stop"
— the `exclusiveConnection` guard, `deleteDatabase` — carry none and must keep failing fast.
That is why the retry gates on the code and not on a VFS name. `stream()` and `chunk()` retry
only before a row has been delivered, since a later retry would repeat rows. It exists for
`OPFSCoopSyncVFS`'s handle-transfer protocol (`mem:vfs`, COOPSYNC-BUSY in `mem:measurements`);
anything else that reports a lock conflict simply gets one free retry. **Since 2026-09-15 that
BUSY no longer occurs**: it was a re-prepare inside one `step` handing the handle away, fixed by the
wa-sqlite patch (COOPSYNC-HANDOVER, `mem:measurements`). The retry stays, for any lock conflict SQLite
reports; no test exercises it any more, and the user ruled that fine — the test that went red to
green is `coopsync-handover.test.ts`.
**Since 2026-09-15 `sqliteCode` also rides on `STATEMENT_FAILED` and `WORKER_CRASHED`**, so
`isRetryableBusy` must keep testing `code === 'BUSY'` as well: the presence of a code no longer
means a lock conflict on its own.


`src/orchestrator.ts` is **deleted** and with it every `SharedArrayBuffer`. Do not look
for it.

## The browser suite runs on two engines, from two config files (2026-09-03)

`tests/browser/*.test.ts` is the shared suite and runs on BOTH engines.
`tests/browser/firefox/**` holds tests that assert Firefox's own behaviour and cannot pass on
Chromium — today, handle starvation, which cannot occur where `readwrite-unsafe` gives each
connection its own OPFS handle. A `chromium/` directory is declared in the include and does
not exist yet; create it only when something needs it.

**The shared glob is NON-recursive, and that is load-bearing.** `tests/browser/**` would make
each project pick up the other's directory, which is the whole thing the layout prevents.

**Two config files, and NOT by preference.** `rstest.config.ts` carries `unit` + `chromium`;
`rstest.firefox.config.ts` carries `firefox`. rstest 0.11.8 **refuses two browser-enabled
projects with different engines in one run** — *"All browser-enabled projects in one run must
share provider/browser/headless/providerOptions"* — so putting both in one `projects` array
makes `pnpm test` fail before it runs anything. Verified, not deduced. The `test` script
chains the two configs, so one command still covers both engines.

This replaced `TEST_BROWSER`, a single project whose engine came from the environment. Under
it a local `pnpm test` covered Chromium while CI covered both, which is precisely how a
Firefox-only failure reaches someone late. **`pnpm test` now prints TWO reports** — read both.

**Conformance got the same treatment the same day**, in `rstest.conformance.config.ts` +
`rstest.conformance.firefox.config.ts`, chained by `pnpm test:conformance`. No per-engine
directory there and there should not be one: the value of that suite is the SAME invariants on
both engines — a VFS sound on one and broken on the other is how HANDLE-1 was found.

## Public surface

`SQLiteQueryAPI` — `read` / `write` / `chunk` / `stream` / `first` / `bulkWrite` /
`output` — is shared by **both** the client and a transaction, so a method cannot be
added to one and forgotten on the other. `SQLiteDB` adds `transaction` / `close` /
`debug` / `inspect`, plus seven readonly getters — `id` / `name` / `file` / `files` / `vfs` / `build` / `poolSize` (the pool it
actually runs: the option, capped by the VFS and by the environment, exact once `ready` resolves) — and
`ready: Promise<void>`, which settles once the pool has started,
which exist so a module handed a client can describe it without also being handed its options;
`SQLiteTransactionDB` adds `commit` / `rollback`. `signal` on every method **except `inspect`** and the transaction controls `commit` / `rollback` (no options at all, like BEGIN and COMMIT on the wire; `tx.savepoint()` and its handle follow them, user 2026-10-04) —
a documented exception: `navigator.locks.query()` takes no lock and waits for nothing, so the
parameter could only abort the `.then()`.
and `chunkSize` on the three that stream. Client options: `name`, `poolSize`,
**`vfs` (required)**, `build`, `pragmas`, `maxWorkerRestarts`, `openTimeout`,
`drainTimeout`, `debug`. The entry exports exactly these names, pinned at runtime by `tests/unit/exports.test.ts`. Values: `createSQLiteClient`, `deleteDatabase`, `inspectDatabase`, `detectFeatures`, `missingFeature`, `SQLiteError`, `SQLiteBulkWriteError`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`. Types: everything `src/api.ts` exports, plus `CreateSQLiteClientOptions`, `WorkerLostEvent`, `DeleteDatabaseOptions`, `InspectDatabaseOptions`, `DatabaseInspection`, `ClientInspection`, `InspectionBase`, `DatabaseClient`, `SQLiteVFS`, `SQLiteBuild`, `PlatformFeature`, `SQLiteErrorCode`, `SQLiteResultCode`, `SQLiteExtendedResultCode`, and since 2026-09-30 `ClientDebugState`, `WorkerDebugState`, `RequestDebugState`, `QueryDebugState`. The package declares no subpath but `.`. The bench page gets its VFS table from `scripts/bench/assemble.ts`, which writes it only when the page imports it, because `pages.yaml` runs the current assembler over the published tag. `SQLiteDB.debug` is declared `debug?: ClientDebugState | undefined` — an optional key that may hold `undefined` — since this chantier: under `exactOptionalPropertyTypes` a plain `debug?:` refused the client's always-present, possibly-undefined key, so the declared type was widened, not narrowed, to match what the client publishes. `ClientDebugState` stays unexported (`@internal`); whether `db.debug` itself is public is the documentation review's call (`mem:follow-ups`).

**Every root export names the database positionally** — `createSQLiteClient(file, options)`,
`deleteDatabase(file, options)`, `inspectDatabase(file, options)`. `inspectDatabase` shipped on
its branch taking one `{ file, vfs }` object and was changed before the merge; the spec carries
the amendment. A missing `vfs` is refused by name, not reported back as `Unknown vfs 'undefined'`.

## Load-bearing invariants — weakening any of these reopens a closed bug

**`db.ready` is settled by the client, never derived from the scheduler's gate.** `settleGateSlot`
resolves `gateDeferred` and THEN calls `onGateOpen`, which may still `failClient` (empty pool, or
worker 0 lost before the probe). So `readyDeferred` resolves as `onGateOpen`'s last statement and
is rejected in `failClient` and `close()`; first settle wins. Guarded by `lifecycle.test.ts`'s
"pool is empty at gate-open" test (spec `2026-09-23-db-ready-design.md` §2).

**Exclusivity rests on availability being unreachable from outside `scheduler.ts`.**
`PoolWorker` carries no `available` field: it was deleted, not guarded. Workers are handed
out as `Lease` objects whose `release()` is idempotent and is the only way back into the
pool. Two things that look like tidying and would reopen B1:

- adding any availability flag to the worker object, however well-guarded;
- making a worker-bound helper in `queries.ts` release a lease it did not acquire. The
  public methods own their leases; the worker-bound variants own nothing. **Keep the two
  forms distinguishable by name.**

**One query is in flight per worker, and the statement cache now depends on it.** A leased
worker leaves the scheduler's `available` set until `release()` puts it back, which is what
makes `worker/statement-cache.ts` correct without a lock of any kind: its statements outlive
the query that compiled them. Lend a worker to a second concurrent caller and the exit
`reset` lands on a statement another query is part-way through, while an eviction can
finalise a handle that query still holds — a use-after-free on a `sqlite3_stmt` pointer.
Before the cache this was merely confusing. The consequence is written where someone would
break it, on the `available` declaration in `scheduler.ts`, not only in the worker.

**wa-sqlite's retrying VFS depend on the same rule** (`OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`):
`Module.retryOps` is one list per module, so two `retry()`-wrapped calls (`open_v2`, prepare,
`step`) in flight in one module give a spurious `SQLITE_BUSY` and can strand the access handle
(wa-sqlite #341, RETRY-OPS in `mem:measurements`). The library holds it: one database per
worker (`open()` refuses a second), one query per connection, a query awaits `openedDB` so
it never meets the open's pragmas, and `close` waits for `idleUntilQueryEnds()`.

**The extended result code is read where the statement fails, never when the reply is built
(spec 2026-09-14, §5.1).** `sqlite3_extended_errcode` reports the connection's MOST RECENT call,
and the error path runs more calls: `settle`'s reset or finalize, and after a failed savepoint
conclusion a full `ROLLBACK`, which resets it to 0. So `query` stamps wa-sqlite's error
(`extendedCode`, `??=`) at three sites — `run` (bind, step); the fresh branch's inner catch (a
later statement's prepare failure, before that branch's `finally` finalizes anything); and
`query`'s outer catch (the uncacheable branch, where wa-sqlite's `statements()` runs only
`sqlite3_errmsg` and `sqlite3_free` in between). **A new path out of `query` that runs SQL before
reaching one of them sends a wrong code.** The fresh-branch stamp has no falsifier; the other two
do. The client's `subtypeOf` (`pool.ts`) drops the value when it equals `sqliteCode` and keeps
every other difference, 0 included, so a wrong read stays visible.

**A transaction statement does not resolve until the worker is idle again, and that rule is
held by DISCIPLINE, not by structure.** `settled` (inside `withSignal`) now takes the query
helper as a function of the worker facade and the options; the idle wait is owed only by a
statement that was POSTED (`mark.posted`, which replaced `owesWait`). The one exception: a
savepointed write rejected by its OWN signal moves its wait to `abandoned`, awaited instead
by every entry point through `entryWait` (spec 2026-09-11) rather than at the statement's own
`settled`/`releasing`. Statements inside `transaction()` share one worker
with no scheduler lease between them, so one that leaves its transport without reaching
`done` — `first()` on any query with a row left to produce, a generator `break`-ed out of, a
statement cut short by an abort — leaves `pool.ts`'s `deferredChunk` set and the NEXT
statement in the same callback meets the reuse guard. `queries.ts` fires `iterator.return()`
without awaiting it deliberately, for the client path, where a lease does the waiting; the
transaction has no lease between statements, so it must wait for itself.

The rule, and the thing to check when a seventh method is added to `SQLiteTransactionDB`:

- **A promise-returning statement returns through `withSignal`'s `settled`.** The pairing is
  the whole defence — a method gets its merged signal there or not at all, so one that skips
  the helper is visibly wrong rather than quietly missing its wait.
- **A generator-returning statement waits in `releasing`'s `finally`**, which is the only
  other place a statement can end.
- **Neither waits when `pool.ts`'s reuse guard refused the statement** (`mark.posted` stays
  false — the name `owesWait` is gone). A refused statement never claimed the worker, so the query in flight is somebody else's;
  waiting for it parks the rejection behind a generator that only `closeOpenStatements()`
  will close, at the end of the callback — where the rejection was heading. That deadlocks,
  and it is how the first version of this fix failed.

**A statement inside a transaction is ALWAYS abortable**, because `withSignal` merges the
transaction's signal into every statement and `closeSignal` is always defined. Comments
claiming otherwise were false and were corrected on 2026-09-10; what decides whether a
running `step()` can actually be cut is the BUILD — the `sync` build without cross-origin
isolation installs no progress handler at all. Numbers: `mem:measurements`, TX-QUIESCE.

**A transaction ends once, and its handle knows it (merge `eeabe06`, 2026-09-11).** Design:
`docs/superpowers/specs/2026-09-10-transaction-abort-design.md` — read its dated amendments,
two decisions changed after the final review. `createTransaction` records `ending` —
`committed`, `rolled-back`, or `died` with a cause — and every public method of `tx` reads it
FIRST: once it is set nothing the handle does reaches the worker, which may be serving
another lease by then. Statements reject (`bulkWrite`/`output` throw) `TRANSACTION_CLOSED`
with `cause` = the cause of death, absent after a normal end; `commit()` resolves only if the
transaction committed; `rollback()` always resolves and warns through `logger.always.warn`
after a commit. What must hold:

- **The teardown uses `commitNow()`/`rollbackNow()`, never the public `commit()`/`rollback()`**
  — those return early on a closed handle, so a teardown calling them would leave SQLite's
  transaction open on a pooled connection.
- **A COMMIT that succeeds records `committed` unconditionally; a ROLLBACK keeps an earlier
  death** (`??=`). The handle reports what happened to the data.
- **Every cause of death goes through one signal.** An internal `death` AbortController is
  merged into the transaction's signal; `die(cause)` is a no-op once ended. The race against
  the callback, statements in flight, `ending` and `tx.signal` therefore all see a death the
  same way. The inner `catch` calls `die(e)` first, which is what makes `tx.signal` abort
  whenever `transaction()` rejects; `releaseDeath()` and the `onAbort` removal run BEFORE
  `await afterWrite`, so nothing aborts it once the transaction has resolved.
- **What kills a transaction:** the three outside causes (its own `signal`, its own
  `timeout`, `close()`); an error escaping the callback; and the connection reporting it left
  the transaction (`worker.inTransaction === false` after `quiesce()`). A write or a load
  abandoned by its OWN signal/timeout while it ran is NO LONGER one of them: that write is
  now undone by the library's own savepoint (`__bsq_sp`, spec 2026-09-11) and the transaction
  goes on. An abandoned READ does not kill it either, and never did.
- **A closed handle's `chunk()`/`stream()` throw before `releasing`'s `try`**, so they never
  wait on `quiesce()` — the `mark.posted` rule above, and the final review found that rule
  applied on one of the two paths only.

**Every message a transaction sends goes through `via`, except the teardown ROLLBACK.**
`via(open, mark?)` is the facade whose `query` hands the pool a thunk read at post time and
carries the pending conclusion of `__bsq_sp` — the savepoint a self-abandoned write leaves
open for the transaction's next message to resolve. The teardown ROLLBACK (`rollbackNow`)
goes to the raw worker, never through `via`: a full ROLLBACK discards every savepoint, so
there is nothing to conclude, and a RELEASE sent to a connection that already left its
transaction would fail and evict a healthy worker through `onPoisoned`. A new statement
method that calls a query helper with the raw worker instead of `via(…)` breaks the undo
silently — its first message carries no pending conclusion, so a savepoint opened by an
earlier abandoned write is never
resolved. `tests/unit/transaction.test.ts` T7 is parameterised over the methods to catch it. `tx.savepoint()`, `release()` and `rollback()` go through `via(false)` in `runControl`, and T7 covers them.

**The worker's authorizer is the only guard against transaction control (spec 2026-10-04, § 4).** It denies `SQLITE_TRANSACTION` and `SQLITE_SAVEPOINT` unless the message carries `control`, which only `transaction.ts`'s `exec` and the worker's own `__bsq_sp` `control()` set; `controlSql` remembers the control statements it allowed so a cache hit cannot bypass it; savepoint operations run `uncached`. A new library path that sends transaction control without `exec` is refused with `AUTH`. Transaction control is allowed while a statement is stepping — VACUUM runs its own BEGIN/COMMIT during its step; a consumer's control statement is refused at its own prepare, or by `controlSql` on a cache hit, always before any step. The cache-hit refusal sets `extendedCode = SQLITE_AUTH` itself, because no SQLite call failed and `stamped` would otherwise read a stale code.

**A load's batches are savepointed individually, not the load as a whole.** `bulk.ts`'s
`runBatch` issues one `tx.write()` per batch, each independently savepointed by `withSignal`
— never one savepoint spanning the whole `bulkWrite`/`output`. A load-wide savepoint would
silently undo writes the callback itself ran BETWEEN two batches when a later batch is
abandoned (spec D6).

**`PoolWorker.inTransaction` is connection state, NOT availability.** Written only in
`pool.ts`'s `onmessage` (the `done`/`error` of the current callId), which runs before `idle`
resolves — so it is fresh once `quiesce()` returns; read only by `transaction.ts`. Nothing
schedules on it, and a scheduler read of it would reopen B1's shape.

**`PoolWorker.terminate()` is NOT the browser's method any more — it poisons the
transport first.** `PoolWorker` is the native `Worker` (`Object.assign` in `pool.ts`), so
terminating used to stop the thread and tell the transport nothing: a request posted
afterwards waited for a reply that could never come. It now calls `poison()` — the half of
`die()` that rejects without reporting to the client — then the engine's terminate. It takes
an optional reason, and `close()`, `handleDeath` and `failClient` each pass their own.

Two consequences to know before writing anything near it. **A test that simulates the ENGINE
killing a worker must use `killSilently()` from `tests/browser/helpers.ts`**, which reaches the
native method past the override; `worker.terminate()` no longer simulates a silent death, and
two tests went red proving it. And **the method was overridden rather than added beside**
deliberately: there are several terminate sites and a new one must not be able to forget.

**The lease returns on quiesce, not on the caller's exit.** After a read method's `try`
block finishes, the `finally` calls `lease.worker.quiesce()` and releases only once the
worker confirms it is idle. The caller does not wait — it already has its result. So a
worker still inside `sqlite.step()` is never re-lent: the exclusivity guarantee holds at
the worker level, not just at the scheduler level.

**`lockPolicy: 'shared'` on every VFS is a condition of the pool's existence, not a
preference.** wa-sqlite's own default is `'exclusive'`, where a connection holds the file
for its whole session — under it the second worker of our own pool would never open the
database. `'shared'` maps SQLite's lock levels onto Web Locks instead, which is what lets
`poolSize` connections share one file. Anyone tempted to drop the option and inherit the
default is removing concurrent reads. The other option of the same mixin, `lockTimeout`,
is left at `Infinity` deliberately: it applies only to blocking acquisitions, and the
write-lock transitions are polled (`ifAvailable`), so it would change nothing that matters.

**`WebLocksMixin` is also what makes `poolSize` visible to `navigator.locks.query()`**, and
rc.5's cross-tab design has to know it: the mixin takes up to three named locks
`lock##<file>##{gate,access,reserved}` per connection, held only while that connection holds
a SQLite lock. One query in flight per worker bounds it at one or two per simultaneously
active worker. **Read from source, never measured** — see `mem:state` for the design that
depends on it and `mem:measurements` for what a held lock costs a `query()`.

**Routing is an allowlist, and its second clause is not decoration.** `isReadQuery`
requires an allowlisted opening keyword **and** no write keyword anywhere in the
statement, because the worker executes `;`-separated statements — `SELECT 1; DROP TABLE t`
opens as a read and is not one. Accepted cost: `SELECT 'INSERT'` and `EXPLAIN INSERT …`
serialize through the writer. String-literal misclassification needs tokenisation to fix
properly; the failure direction is safe toward the writer.

**`take()` awaits the tick unconditionally, before checking credits.** Skipping it when
credits are available is the obvious optimisation and it destroys the property
`credits.ts` exists for — a worker inside a query never returns to its event loop, so no
`postMessage` reaches it. A unit test counts ticks per take and goes red if anyone tries.
For the same reason credits are granted **on consumption** (after the `yield` in
`pool.ts`'s generator), never on arrival: crediting on arrival silently defeats
back-pressure. Use `MessageChannel`, never `setTimeout` — nested `setTimeout` is clamped
to 4 ms.

**A surplus worker declines; it does not die (spec 2026-09-13, §3 and §10).** Where a VFS declares
`singleConnectionWithout` and the engine lacks the feature, only slots of index ≥ 1 receive
`declineWithout`; they probe it (`src/worker/probes.ts`) before loading wasm and post `declined`.
That settles init without `die` — no `onDeath`. `retireSlot` then clears the slot's round-1
`startupLosses` entry, reports `'retired'` to the supervisor BEFORE `scheduler.retire` (which may
open the gate, and `onGateOpen` reads `liveCount`), and decrements `effectivePoolSize` — what
`db.poolSize` and `WorkerLostEvent.size` report; on a closing client it changes nothing
observable. The gate settles a retired slot as `'declined'`, neither opened nor failed, so it never
enters the retry round. Slot 0 never probes. Where the probe passes, nothing differs from before.

**Poisoning a transport settles a pending `close()`.** A dead worker can never reply `closed`;
before 2026-09-14, `close()` sat out `drainTimeout` for a worker terminated while closing.

**`deleteDatabase` on a VFS with a `folder` deletes through OPFS only**, after the VFS has
closed: every sidecar first — `DATABASE_FILE_SUFFIXES` plus the declared `extraFileSuffixes` — and the
main file last, so a failed removal stays retryable. `jDelete` stays for the IndexedDB VFS and
`AccessHandlePoolVFS`, which have no OPFS pass. The VFS folder itself is never removed: a first open
of another database in it could be between `getDirectoryHandle` and `getFileHandle`, and nothing
locks two databases of one folder against each other.

## Two names per database (2026-09-23, `feat/vfs-folders`)

`resolveDatabase(file, vfs)` runs once at each of the three entry points — `createSQLiteClient`,
`deleteDatabase`, `inspectDatabase` — and returns `{ file, path }`:

- **`path` is the identity everywhere downstream**: every lock name, the epoch registry, client
  markers, bulk, the name posted to the workers, `db.debug.file`. On `OPFSAdaptiveVFS`,
  `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` it is `.<folder>/<name>`
  (`.ad`, `.ac`, `.cs`, `.wa` — the dot added by `databasePath` to `VFS_CAPABILITIES.folder`);
  elsewhere it is the name. The init lock is taken both in the worker and on `deleteDatabase`'s main
  thread — one string for both is what keeps an open and a deletion mutually exclusive.
- **`file` is what the public surface reports**: `db.file`, `InspectionBase.file`, error messages.
  `db.file` is documented as what to hand back to `inspectDatabase` / `deleteDatabase`; carrying the
  path would double the folder. `inspectWith` takes the logical name and derives the path itself.
- **`resolveDatabase` refuses**, with `INVALID_OPTION`, a path over `MAX_DATABASE_PATH` = 64 − 8 = 56
  (SQLite's `nPathname + 8 > mxPathname` before `xOpen`; 52 for the name on a folder VFS), counted on
  the normalized path — and a name empty once normalized (`''`, `'/'`, `'?x'`…).
- **The worker is not touched by the folder**: the four VFS create intermediate directories with
  `{ create }`, and `opfsEntryExists` / `removeOpfsEntry` walk the path's segments.
- **`db.files`** is derived, not observed — `databaseFiles(vfs, path)` — so it lists a `-journal` an
  earlier session left; empty on the memory VFS.

**Test fixtures sit under the same bound**: a name built around a 36-character UUID has 16 characters
left with a 4-character folder. `browser-sqlite-test-${uuid}` was exactly 56 and failed every open
once the folder arrived.

## Scheduling rules

1. **A read never touches the writer designation** — it does not take the writer by
   preference, and does not clear the designation when the writer happens to serve it.
   Both acquisition paths behave identically.
2. **No preference of any kind when choosing a worker for a read.** Lowest-index-first.
3. **The writer designation is released as soon as no write is queued behind it.**
   `handOver` clears it below the `serveWriterFirst` call: reaching that line proves the
   writer queue is empty, and since a worker holds one lease at a time no write is in
   flight either. Consequence: **`designated` and `leased` now coincide**, so a read can
   never meet an available designated worker.

Rule 3 stands on the barrier. Stickiness once existed because consecutive writes on
different workers failed with `no such table` — `sqlite3_prepare_v2` reads the schema
through the stale page map before `SQLITE_LOCK_RESERVED` is requested. That evidence is
not wrong, it is *answered*: `applyBarrier` covers `kind: 'write'`, so a newly designated
writer absorbs the previous commit before it prepares anything. **Anyone tempted to remove
the barrier must know it is what holds rule 3 up.**

## The barrier and cross-tab

The commit-propagation barrier and the cross-tab invariants are in `mem:architecture/cross-tab`.
