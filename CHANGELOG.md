# Changelog

All notable changes to this project are documented here.

## 1.0.0-rc.4 — 2026-08-31

Everything below lands between rc.3 (2026-03-26) and rc.4. The library was
rewritten around a leased worker pool in that interval; the public surface moved
with it.

### Breaking

- **`TransactionDB` is now `SQLiteTransactionDB`, and it is exported.** It
  appeared in `transaction()`'s signature without a consumer being able to name
  it.
- **`BulkWriteError` is now `SQLiteBulkWriteError`.**
- **`SQLiteQueryOptions` no longer carries `chunkSize`.** The methods that
  stream take `SQLiteChunkOptions`; the others take `SQLiteQueryOptions`.
- **`output()` is typed.** Its options and the rows passed to `enqueue` were
  `any`; a call that passed a mistyped row now stops compiling.
- **`vfs` is now required.** If you relied on the default, pass
  `vfs: 'OPFSAdaptiveVFS'` to keep reading your existing database. A VFS decides
  where the bytes live, so a default that moved between versions would leave you
  reading an empty database while your data sat in a store nothing queries.
- **`DEFAULT_VFS` is no longer exported.** There is no default. Write the VFS
  name in your own source, where it cannot move.
- **`one()` is now `first()`**, and it stops the query after one row instead of
  draining the whole result set.
- **`stream()` yields rows**, not chunks. The chunk-wise path is the new
  `chunk()`.
- **`close()` returns a promise.** It rejects queued work, drains what is in
  flight, closes the database in each worker, then terminates them.
- **`read()`, `first()`, `stream()` and `chunk()` reject a write statement**
  instead of running it, with `SQLiteError('NOT_A_READ_QUERY')`.
- **`output()` lost its `temp` option.** A TEMP table lives on one connection
  and is invisible to the rest of the pool.
- **`bulkWrite()` and `output()` are single-use.** Enqueueing after `close()`
  throws rather than buffering rows nothing will flush.
- **`SQLiteQueryOptions` lost its type parameter and two fields that did
  nothing.** `id` and `debug` were declared on every query method and read
  nowhere. Code that passed them keeps behaving identically; it simply stops
  compiling.
- **`OPFSPermutedVFS` is removed.** It measured 24 % stale cross-connection
  reads and is deprecated upstream.
- **`VFSCapability.requiresUnsafeHandles` is replaced by `requires`,
  `degradesWithout` and `storage`.** A boolean could only say "unsupported",
  which was wrong for `OPFSAdaptiveVFS` — it runs everywhere and merely degrades
  without `readwrite-unsafe`. Code that read `requiresUnsafeHandles` reads
  `requires.includes('readwrite-unsafe')` instead; the two new fields carry the
  degradation and the storage placement the boolean could not express. The
  feature names are the exported `PlatformFeature` union, and `storage` is
  `VFSStorage`.

### Added

- **An abort now reaches a call that is still waiting for a worker.** `signal`
  was consulted only once a worker had been leased, so while the pool had
  nothing to lend — `OPFSCoopSyncVFS` on an engine without `readwrite-unsafe`
  rotates one exclusive OPFS handle, and a hand-over may never arrive — an
  abort could not land at all. It now rejects with `signal.reason` while the
  request is queued, and is ignored once the lease is granted.

  **Timing changed with it:** an aborted call that is still queued rejects
  synchronously from inside `abort()`, where it used to reject only when a
  worker came free. Attach your handler before calling `abort()`, or the
  promise crosses a microtask checkpoint unhandled.
- **`bulkWrite()` and `output()` accept `{ signal }`.** They were the two
  longest-running methods in the public surface and the only two that could not
  be cancelled. The abort lands **between** batches — a multi-row INSERT is
  statement-atomic, so stopping inside one either wastes it whole or lets it
  commit whole. `close()` rejects with `signal.reason`, the same contract the
  query methods already honour. An aborted `bulkWrite()` leaves the batches
  already written in place; run it inside `transaction()` when abandoning must
  mean rolling back. An aborted `output()` is observationally a no-op: the
  staging table is dropped and the previous target is untouched.
- **`enqueue()` returns a promise, and `{ queueSize }` bounds the load.** A
  producer that awaits it is slowed to the speed of the database; one that
  ignores it loads exactly as before, so nothing written against the old
  signature changes behaviour. Only the buffer was ever bounded — the chain of
  batches handed over and not yet written was not, so a JavaScript loop against
  OPFS writes grew memory with batches in flight. The default is two batches'
  worth, derived from the column count; a value smaller than one batch is legal
  and means one INSERT in flight. It bounds a number of rows and says nothing
  about what they weigh — set it yourself when your columns carry blobs. The promise **never rejects**: a failed batch still
  surfaces at the next `enqueue()`, which throws, and at `close()`, which
  rejects.
- **`transaction()` accepts `{ signal }`.** It was the last public method that
  could not be abandoned, and the only one that held a worker exclusively while
  it could not. The signal aborts the wait for a worker, every statement issued
  through `tx`, and the callback itself — a callback parked on something that is
  not a statement no longer keeps the transaction alive. An abandoned
  transaction rolls back and rejects with `signal.reason`, and it never commits:
  a callback that catches its own statement's rejection and returns normally is
  refused at the commit. A statement given a signal of its own is aborted by
  either signal, with the reason of whichever fired.

  Your callback is not interrupted — it is your code — but it can no longer
  reach the database: every statement it issues after the abort rejects without
  a worker round trip.

  **`BEGIN`, `COMMIT` and `ROLLBACK` never carry the signal.** Their completion
  is what decides whether a rollback is owed, so aborting one client-side would
  risk returning a worker to the pool with the transaction still open. A
  transaction is therefore not abandonable while one of them is in flight; the
  abort lands as soon as it settles.
- **`deleteDatabase(file, { vfs })`** — a supported way to remove a database and
  the `-journal` / `-wal` files beside it, on every VFS that persists one. On
  `AccessHandlePoolVFS` it is the only correct removal: it returns the pool slot,
  where deleting the OPFS file by name would match nothing. Storage a VFS keeps
  for itself is left alone — the shared IndexedDB store and the pool directory —
  while the named database's bytes are freed. Deleting a database that is not
  there is not an error; deleting one that is open reports `BUSY`.
- **`wasmUrl` client option** — an escape hatch for where the workers fetch
  their `.wasm`. A string names a directory, resolved against the page; a
  callback receives the resolved `build` and names one file, for a
  bundler-emitted asset carrying a content hash. It is called once, at
  construction. Omitting the option leaves resolution exactly as it was: the
  files are read from beside `worker.js`, which is where every bundler in the
  smoke test emits them.
- `SQLiteError` code `READ_ONLY_TRANSACTION`, raised when a write, `bulkWrite()`
  or `output()` is attempted in a `readOnly` transaction. `bulkWrite()` and
  `output()` refuse at the call rather than at the first flush.
- **`bulkWrite()` and `output()` are available on a transaction.** A bulk load
  inside `transaction()` is atomic: it rolls back with everything else. Outside
  one, `bulkWrite()` stays streaming and commits per batch.
- The public type layer is exported: `SQLiteQueryAPI`, the two surfaces deriving
  from it, and every option, result and writer type they use. `stream()` now
  accepts `chunkSize`, which bounds how far the worker may run ahead.
- `chunk()` — the chunk-wise read primitive every other read method is layered
  on, and the single place an `AbortSignal` is honoured.
- `signal` on every query method.
- `SQLiteError` with a `code` discriminant, and `SQLiteBulkWriteError` carrying
  `rowsWritten` / `rowsNotWritten`.
- `build` option — choose the wa-sqlite WASM build (`sync`, `async`, `jspi`),
  validated at construction.
- `VFS_CAPABILITIES` — the declared table behind every VFS: supported builds,
  pool limits, memory model, storage placement and platform requirements.
- `detectFeatures()` and `missingFeature()`, so an application can ask whether a
  browser can run a given VFS and build before constructing a client.
- `createSQLiteClient` checks platform support at construction and throws
  `SQLiteError('INVALID_OPTION')` naming the missing feature and an alternative,
  instead of failing later inside a worker.
- Five VFS wired: `OPFSWriteAheadVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS`,
  `MemoryVFS`, `MemoryAsyncVFS`.
- `maxWorkerRestarts`, `openTimeout` and `drainTimeout` options.
- `debug` accepts a boolean; `db.debug` exposes a live introspection tree, and
  lifecycle events go to a prefixed logger.
- Back-pressure on `stream()` and `chunk()` — the worker takes a credit per
  chunk, so a query in flight stays reachable and cannot pile up chunks.
- Worker crash detection with bounded per-slot restart.
- A benchmark and conformance page, published alongside each release, that
  measures the VFS on the visitor's own browser.
- **`onWorkerLost`** — a callback for a worker lost for good, receiving the slot
  index, how many workers are left, the requested `poolSize` and the error. It
  fires before the client fails when the last worker goes, and a callback that
  throws is caught rather than allowed to break the pool. `WorkerLostEvent` is
  exported so a standalone handler can name its parameter.
- **`db.debug.queue.gated`** — callers waiting for the pool to *exist*, which is
  a different wait from waiting for a free worker and which `read` and `write`
  cannot see: a caller suspended on the readiness gate is in neither queue.

### Performance

- **Repeated SQL is compiled once per worker.** A per-worker LRU cache retains
  prepared statements across executions, where each execution used to compile
  its own and throw it away. Anything you run more than once on the same worker
  benefits after its first execution — a repeated `SELECT`, and every batch of a
  `bulkWrite`, whose INSERT template is the same for all but the last batch. The
  gain is largest where the statement is largest and where compilation is
  slowest, so it varies by browser. Multi-statement strings are not cached and
  keep their previous behaviour. The cache is invisible: no option, no
  constraint, no behaviour change.
- **Each result row is built with less allocation.** Building a row no longer
  goes through an intermediate array of key/value pairs. Measured over 50 000
  rows of 12 columns, that step alone drops from 17.5 ms to 4.4 ms on Chromium
  and from 23 ms to 14 ms on Firefox; what it is worth on your query depends on
  how much of it is spent reading rows back. No API or behaviour change.

### Changed

- **The package declares `sideEffects` and `engines`.** `sideEffects` lists the
  worker entry alone — it installs a message handler on import — so a bundler
  may tree-shake everything else. `engines` states `node >= 18`.

- **Cross-origin isolation is no longer required.** No COOP/COEP headers,
  anywhere — the `SharedArrayBuffer` is gone.
- **No runtime dependencies.** wa-sqlite is vendored into the shipped worker at
  build time; `dist/` is flat and free of bare specifiers.
- **Read-your-own-writes is guaranteed within a tab.** A commit-propagation
  barrier refreshes a worker that has not observed the latest commit.
- The writer designation is released as soon as no write is queued, so a long
  read no longer freezes every write in the client.
- Reads pick the lowest available worker, with no preference of any kind.
- Read PRAGMAs route through `read()` again; pragmas are applied once at open
  rather than before every query.
- `IDBMirrorVFS` is declared single-connection with its pool capped at 1 —
  measured, not inferred.
- The README documents a sourced browser baseline and generates its VFS table
  from the capability table.
- **The first query waits for every worker to settle, not for the first one to
  be ready.** `poolSize` was a request rather than a promise: a query served
  while the other workers were still opening could, on a VFS in reduced mode,
  hold the one exclusive OPFS handle their `open` needs and starve them for its
  whole duration — leaving a pool permanently smaller than asked for. The cost
  is the first query's latency, which is now the time to open the pool.
- **A worker that fails to open is retried once, if another worker did open.**
  The old rule refused to restart any slot that had never been ready, on the
  grounds that an initial failure is a configuration error. That holds only when
  *no* slot opened; when the others opened with the same configuration, the
  failure is contention, not configuration. With none opened the client still
  fails immediately rather than retrying.
- **A permanently lost worker always warns, even with `debug` off.** A pool
  quietly smaller than `poolSize` is not something to discover later.
- **Option types now say `?: T | undefined` where an explicit `undefined` is
  accepted.** The library compiles under `exactOptionalPropertyTypes`, which
  separates "the property is absent" from "the property is `undefined`" — a
  distinction JavaScript makes wherever code branches on presence, and one this
  library depends on when it decides whether to pass Emscripten a `locateFile`.
  Nothing a caller could write before stops compiling; the declarations simply
  say which of the two they mean.

### Fixed

- A write in a read-only transaction threw a bare `Error`, the only guard in the
  library that escaped the `code` discriminant.
- **A `BEGIN` that failed evicted a healthy worker.** `transaction()` rolled
  back on any error from the moment it held a lease, including one raised by the
  `BEGIN` itself — and a `ROLLBACK` on a connection holding no transaction fails
  in turn, which the client read as a connection that could not be trusted and
  respawned. The rollback is now owed only once `BEGIN` has come back.
- **Exclusivity.** A borrowed worker could be handed to a concurrent read, so a
  query could execute inside someone else's open transaction. Availability now
  lives behind opaque leases and is unreachable from outside the scheduler.
- **SQL injection through generated identifiers.** Every table, column and index
  name is quoted; pragmas are validated at construction.
- **`output()` is atomic.** It loads into a staging table and swaps it in; the
  previous table stays intact and populated until the swap succeeds, and orphan
  staging tables are swept across tabs.
- **`bulkWrite()` latches the first batch failure** instead of dropping rows in
  silence.
- A worker that died while replacing a worker that died left the client alive,
  empty and silent forever.
- A query aborted before dispatch, and a stream aborted mid-flight, no longer
  yield rows after the abort.
- `close()` rejects an in-flight stream instead of truncating it silently.
- `SQLITE_BUSY` and `SQLITE_LOCKED` surface as `SQLiteError('BUSY')` on both the
  query and the open paths.
- A worker whose fallback `ROLLBACK` failed is evicted rather than returned to
  the pool with a transaction open.
- `OPFSAnyContextVFS` on Safari — WebKit ignores a typed-array view's offset on
  write, patched in this repository.
- Database names are normalized once, which also fixes `OPFSWriteAheadVFS`
  throwing on a relative path.

## 1.0.0-rc.3 — 2026-03-26

First published release line.
