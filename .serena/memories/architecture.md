# Architecture — what the code is

`browser-sqlite`: persistent SQLite in the browser — wa-sqlite (WASM) + a Web Worker
pool + an OPFS/IndexedDB VFS. **Concurrency model: concurrent reads across the pool,
writes serialized through one designated writer worker.** That model is sound and is the
thing worth preserving.

Stack, build output and test tooling: `mem:stack-and-build`. VFS: `mem:vfs`.

## Layout — line counts verified 2026-08-28 (post `feat/statement-cache`)

| File | Lines | Role |
|---|---|---|
| `api.ts` | 318 | **The public type layer, and the only module `index.ts` re-exports wholesale.** `SQLiteQueryAPI` is the querying surface; `SQLiteDB` and `SQLiteTransactionDB` are it plus their own extras. Everything here is public by construction, which is what stops the leak that made `SQLiteQueryOptions` and `TransactionDB` unnameable — a name list in `types.ts` is what you forget to update. |
| `client.ts` | 739 | **Assembly only**: options, validation, wiring, the public `SQLiteDB` surface, `close()`. Holds `DEFAULT_POOL_SIZE = 2` and `DEFAULT_STATEMENT_CACHE_SIZE = 32`, the vfs/build guard, `applyBarrier` (`:506`) and `acquireInstrumented` (`:562`) — **the single choke point through which every read, write, transaction and bulk acquires a lease**, which is what makes the barrier one wrapper rather than six. |
| `capabilities.ts` | 121 | `detectFeatures` / `missingFeature` / `describeMissing`, `BUILD_REQUIREMENTS`, `UNPROBEABLE`. Public: the first two only. |
| `types.ts` | 368 | Wire protocol, `SQLiteQueryOptions`, and **`VFS_CAPABILITIES` — the single source of truth** the client guard, the conformance suite, the README generator and the benchmark page all read. `SQLiteVFS` derives from its keys. |
| `errors.ts` | 61 | `SQLiteError extends Error` with `code` and `name` mirroring it, plus `SQLiteBulkWriteError`. Eleven codes: `NOT_A_READ_QUERY`, `CLIENT_CLOSED`, `WORKER_CRASHED`, `TIMEOUT`, `PROTOCOL_ERROR`, `INVALID_IDENTIFIER`, `INVALID_OPTION`, `INVALID_PRAGMA`, `BULK_WRITE_FAILED`, `BUSY`, `READ_ONLY_TRANSACTION`. |
| `scheduler.ts` | 366 | **Pure** — availability (a private `Set`), both wait queues, writer designation, opaque leases, `remove(index)`, `shutdown(reason)`, per-index generation counter. No `Worker`, no DOM. **This purity is load-bearing: B1 survived for months because the scheduler was only reachable through slow browser tests.** |
| `pool.ts` | 509 | Worker creation and transport: `postMessage`/`onmessage` routed by `callId`, the raw query generator, the stop-and-drain that waits for the worker's in-flight `done` before a lease returns, `onerror`/`messageerror`, the `close` handshake, the per-worker `status` field. |
| `supervisor.ts` | 94 | Pure per-slot restart policy, zero imports. A slot holds a worker **from `spawned`, not from `ready`** — that is SUP-1's fix. Restart counter resets on a request actually served; eviction leaving no live slot fails the client; `evicted` is permanent against a late `ready`. |
| `queries.ts` | 167 | `chunk()` — the single query primitive and **the only place an `AbortSignal` is read** — plus `streamRows`/`readWorker`/`firstWorker`/`writeWorker` and `makeAbortRace`. |
| `transaction.ts` | 200 | `transaction()` over a single lease held for its whole lifetime. Evicts a worker whose fallback `ROLLBACK` failed. |
| `bulk.ts` | 334 | `bulkWrite()` + `output()`. Calls the **public** `write` — one lease per batch, worker released between batches. Do not consolidate it into one held lease; multi-tab safety depends on it. |
| `credits.ts` | 94 | The pure credit gate. `createCreditGate(tick)`, `createMessageChannelTick`, `DEFAULT_CREDIT_WINDOW = 2`. |
| `epochs.ts` | 89 | The barrier's state: a per-database commit epoch in the realm-wide symbol registry (`Symbol.for('browser-sqlite.epochs.v1')`), so every client in a tab shares it. `epochsFor`, `advanceSeen`, `BARRIER_SQL`. |
| `debug.ts` | 238 | Instrumentation behind the `debug` option. Both histories bounded at 50; `queue` is getter-backed and reads through `scheduler.stats()`, so no counter can go stale. |
| `logger.ts` | 30 | `createLogger(prefix, enabled, sink = console)`. **Lifecycle events only** — never per query. Disabled, it returns three no-op closures allocated once. |
| `locks.ts` | 129 | Web Locks wrapper + the pure sweep decision. `createLocks`, `noOpLocks` (use this in tests — `createLocks(undefined)` falls back to the real API and **Node 24 ships one**), `initLockName`, `stagingTableName`/`stagingLockName`/`sweepLockName`, `staleStagingTables`. |
| `utils.ts` | 205 | `isReadQuery`/`isWriteQuery` + `assertReadable` + `quoteIdent`/`renderPragmas` + `sqlParams`/`addParam`. |
| `worker/worker.ts` | 700 | Worker thread: VFS bootstrap, `open`, statement execution, chunked streaming. Holds `VFSConfigs` and `WA_SQLITE_BUILDS`. **Constructs every VFS with `{ lockPolicy: 'shared' }` (`:159`).** `ready` only on success, `open-error` on failure; every `cause` structured-clone-probed; exhaustive message dispatch. |
| `worker/statement-cache.ts` | 85 | **Pure** — a per-worker LRU of prepared statements keyed by the exact SQL string. Prepares nothing, finalises nothing, imports nothing: `set`/`markUncacheable` return the handles their insertion evicted and `worker.ts` finalises them, so no handle can be dropped by omission. Unit-tested in Node against plain integers. |
| `index.ts` | 17 | Re-exports. `types.ts` is exported **by name**, never `export *` — the wire-protocol types are internal. |

`src/orchestrator.ts` is **deleted** and with it every `SharedArrayBuffer`. Do not look
for it.

## Public surface

`SQLiteQueryAPI` — `read` / `write` / `chunk` / `stream` / `first` / `bulkWrite` /
`output` — is shared by **both** the client and a transaction, so a method cannot be
added to one and forgotten on the other. `SQLiteDB` adds `transaction` / `close` /
`debug`; `SQLiteTransactionDB` adds `commit` / `rollback`. `signal` on every method,
and `chunkSize` on the three that stream. Client options: `name`, `poolSize`,
**`vfs` (required)**, `build`, `pragmas`, `maxWorkerRestarts`, `openTimeout`,
`drainTimeout`, `debug`. Exported besides: `SQLiteError`, `BulkWriteError`,
`VFS_CAPABILITIES`, `defaultBuildFor`, `detectFeatures`, `missingFeature`, and the types
`SQLiteVFS` / `SQLiteBuild` / `VFSCapability` / `VFSMemoryModel`.

## Load-bearing invariants — weakening any of these reopens a closed bug

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

## The commit-propagation barrier

Read-your-own-writes is guaranteed **within a tab**, not across tabs. Design:
`docs/superpowers/specs/2026-08-21-ryow-barrier-design.md` — read it rather than any
summary. Four things it settled that are easy to get wrong again:

- The epoch bump **cannot** ride on `lease.release()`: release is async, so `write()`
  resolves first and a read chained after it would still see the old epoch. It is posted
  synchronously in the write path's `finally`.
- New workers start at `seen = -1`, because a commit can land between a worker opening the
  file and entering the pool — the nominal startup ordering at `poolSize: 2`, not a rare
  race.
- `file` is normalized once at the client entry, in **relative** form. That also fixed
  `initLockName`'s raw-string key and `OPFSWriteAheadVFS` throwing on `'./name'`.
- A failed fallback `ROLLBACK` leaves an open transaction on a pooled connection, where
  the prelude would succeed and refresh nothing. The worker is evicted instead.

**The barrier is permanent architecture, not a stopgap awaiting a better VFS** —
staleness is a property of the multi-connection setup, measured identical on every VFS
and every build. Its measured domain and cost are in `mem:measurements`.
