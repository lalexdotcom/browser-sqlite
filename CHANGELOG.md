# Changelog

All notable changes to this project are documented here.

## Unreleased

### Breaking

- **Two clients writing at once no longer produce `BUSY`.** Writes are now
  serialized across every client and tab in the origin, so a second writer waits
  and then goes through instead of being refused. Nothing stops compiling and no
  call changes, but code that caught `SQLiteError` with code `BUSY` between your
  own clients and retried is now unreachable — the condition it handled cannot
  arise. `BUSY` still exists for what it always covered otherwise, including
  `deleteDatabase` against an open database.
- **A write now waits where it used to fail, and the wait is unbounded.** It is
  first-come-first-served. **Pass a `signal` if you would rather fail than
  wait.**
- **`deleteDatabase` is no longer idempotent: deleting a database that is not
  there now throws `DATABASE_NOT_FOUND`.** It used to resolve, which is exactly
  what deleting through the wrong `vfs` looked like. A caller that deletes
  speculatively now needs a `catch`.
- **`DATABASE_IN_USE` is a new error code, and it replaces what a refused
  deletion used to report.** `deleteDatabase` against a database a client still
  holds raised `WORKER_CRASHED` on four VFS and nothing at all on three; it now
  raises `DATABASE_IN_USE` on all of them. A second client on
  `AccessHandlePoolVFS` reports it too. `BUSY` keeps the transient cases —
  an open or another delete in flight, and SQLite's own lock conflicts — so the
  two now say different things: `DATABASE_IN_USE` means close it, `BUSY` means
  retry.
- **`db.debug.name` now carries the client name with its index**, e.g.
  `"SQLite 1"` where it used to report `"SQLite"`. The old value was the bare
  `name` option, identical for every client that passed nothing, so it
  identified nothing even within one tab. It is now the same string the `debug`
  logger prefixes its lines with and the same one the roster reports.

### Added

- **Read-your-own-writes now holds across tabs.** A commit in any tab is observed
  by the next read in every other tab on the same database. `IDBMirrorVFS` is the
  exception and cannot be fixed here: it mirrors the whole database in memory per
  worker and propagates commits asynchronously, so a connection whose mirror has
  not caught up has nothing fresher to read.
- **Writes serialize across clients and tabs**, on every VFS and every browser.
  Previously the outcome depended on the browser: where each connection held its
  own OPFS access handle the second writer was refused, and where one exclusive
  handle was rotated it waited. There is one behaviour now.
- **`inspectDatabase(file, { vfs })` and `db.inspect()` report who is live on a
  database**, across every tab of the origin: one entry per client with its id,
  name, tab and VFS, the number of distinct tabs, and the write lock's holder
  with the number of writers queued behind it. `inspectDatabase` needs no open
  client, which is the point — the question usually arrives from outside.
  **It is observability, not a permission:** the answer is stale the instant it
  resolves, and `deleteDatabase` remains the only authority on whether a
  database can be removed.
- **`db.id`, `db.name`, `db.file`, `db.vfs` and `db.build`** — readonly, and
  available whether or not `debug` is on, so a module handed a client can
  describe it without being handed its options too.
- **`UNSUPPORTED` is a new error code**, raised where the Web Locks API is
  unavailable.
- **`timeout`, a per-query budget in milliseconds.** A query that spends more than it is
  stopped and rejected with the new `QUERY_TIMEOUT` code. It counts **SQLite execution
  time**, not elapsed time: the seconds your own code spends between two chunks of a
  `stream()` are not charged to it, so a slow consumer never kills its own query. For a
  wall-clock deadline instead, pass `AbortSignal.timeout(ms)` as `signal` — it always
  worked and still does. Available on the query methods only: a budget for a whole
  `transaction()`, `bulkWrite()` or `output()` would be a different feature.
- **`QUERY_TIMEOUT`, a new error code.** Deliberately distinct from `TIMEOUT`, which means a
  deadline this library imposed on itself — a worker that never became ready, a deletion
  that did not complete. The new one means the budget you set is spent.

### Changed

- The per-worker statement cache is now bounded in bytes (8 MB) as well as in
  entries (32). This makes the worst case finite and stated; it does not reduce
  the common footprint — one `bulkWrite` retained ~3 MB before and retains ~3 MB
  now. What it bounds is an application whose workers accumulate many large
  templates, where the entry bound alone allowed tens of megabytes. Internal:
  no option changes.
- **A write transaction holds the origin's write lock for the whole of its
  callback.** A callback that never returns now blocks every other writer in the
  origin, not only its own client.
- **`bulkWrite` takes the lock per batch**, matching the per-batch commit it
  already did. Another client's write can still land between two batches, and an
  abandoned load is still partial rather than failed. Use `tx.bulkWrite` where you
  need all or nothing.
- **A write waiting on the origin lock when `close()` is called is rejected with
  `CLIENT_CLOSED`**, the same contract a request queued in the pool already had.
- **An aborted query now stops the statement, not only the wait.** `signal` behaves exactly
  as before from the caller's side — the promise still rejects with `signal.reason`
  immediately, as `fetch()` does — but the worker no longer runs the abandoned statement to
  its end. Measured: a short query issued right after an abort on the same worker waited
  **1 889 ms** and now returns in milliseconds. This holds on the `async` and `jspi` builds
  everywhere, and on the `sync` build when your page is cross-origin isolated. Where neither
  holds, behaviour is unchanged; the README's new *Interrupting a query* section says which
  case you are in and what it costs to change it.

### Performance

- **`AccessHandlePoolVFS` now opens in WAL mode by default**, with
  `locking_mode=exclusive`. That VFS allows one connection per origin anyway,
  which is what makes exclusive locking free — and exclusive locking is what
  lets SQLite use its own write-ahead log without shared memory. Measured on
  200 single-statement transactions, both engines: **about 4.7x faster**
  (Chromium 4.2 to 0.9 ms per write, Firefox 2.0 to 0.5). The access-handle
  pool holds the same number of databases either way. Pass
  `pragmas: { journal_mode: 'delete' }` to opt out.
- **PRAGMAs you pass are now merged with the VFS's defaults, not substituted
  for them.** Setting `foreign_keys` no longer costs you the journal mode your
  VFS declares. A key you set always wins, so naming a pragma is how you refuse
  its default. The full per-VFS set is generated into the VFS table in the
  README, so nothing is applied that you cannot see.
- **Every lease acquisition costs exactly one `navigator.locks.query()`** — reads
  included — to read the origin's published epoch. Counted, on both engines. It
  measures ~0.03 ms on an idle origin and grows ~0.0004 ms per lock held anywhere
  in the origin.
- **Every write costs exactly one exclusive lock and one shared marker.**
  Counted, on both engines; together ~0.11–0.14 ms against a commit measured at
  3.4–5.3 ms.
- **A single-tab application runs no extra barrier statements at all.** The
  barrier count over a mixed read/write workload is identical to the branch point,
  on both engines. The `query()` is the whole of what a single tab pays.
- **Another tab's commit costs one barrier statement per worker, not per read.**
  The first read on a worker that is behind runs it; that worker is then current
  and the reads after it run nothing. Those reads previously ran nothing *and
  served an incoherent snapshot*.

### Fixed

- **`stream()` and `chunk()` silently dropped rows whenever the consumer awaited
  anything between chunks.** A consumer that did any asynchronous work — rendering
  a row, awaiting a fetch, or merely yielding one turn of the event loop —
  received a fraction of its result set, with no error and no short read to show
  for it. Measured on the released code, identical on Chromium and Firefox and
  deterministic across five runs: **501 of 1001 rows** at the default settings,
  **500 of 1001** with a wider credit window. The larger the window, the more was
  lost. `read()`, `first()` and `write()` were never affected — they accumulate
  inside the library without handing control back between chunks, which is why
  this survived four releases. **If you consume `stream()` or `chunk()`
  asynchronously, treat every result set you have processed as incomplete.**
  The transport now queues what the worker delivers instead of holding a single
  slot for it.
- **An `openTimeout` failure no longer blames another tab when there is none.**
  The message said the database *may* be held under an exclusive lock by another
  tab or another client, which misdirects in the case that happens most: a page
  reloaded without `close()` leaves the previous context holding the database,
  and there is no second tab to go looking for. The error now reads the origin's
  client roster before it is raised and says either that other clients of this
  library still hold the database, or that none does — in which case a reloaded
  page, or a holder outside this library, is the likely cause. Where the roster
  cannot be read at all, the previous wording stands. **The `openTimeout`
  option's own TSDoc kept the claim the message had dropped** — it is the
  comment your editor shows on the option — and now says the same thing the
  error does.
- **A read on `OPFSCoopSyncVFS` no longer fails with `BUSY` while the VFS moves
  its access handle between workers.** That VFS holds one exclusive OPFS handle
  and rotates it, and its lock call reports `SQLITE_BUSY` while a transfer is in
  flight — a step of its own protocol that expects the caller to retry. Nothing
  retried, so one ordinary read per session failed, early, on both engines and
  at the default `poolSize`. Reads reported busy by SQLite are now retried once;
  measured, the first retry cleared it every time, in 10-17 ms. Writes are not
  retried, and a `BUSY` this library raises to mean "stop" — a database in use,
  a delete in flight — is untouched and still fails immediately.

- **The documentation said deleting through the wrong VFS was harmless. It is not,
  and now it says so.** Measured on both engines: `OPFSAdaptiveVFS`,
  `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` all resolve a
  database name to the same file, so `deleteDatabase` through any of them destroys
  a database created by any other — and resolves without reporting anything. The
  README and the error message raised when `vfs` is omitted both claimed the
  opposite. Behaviour is unchanged; the guidance was wrong.
- **`deleteDatabase` no longer destroys a database a client still has open.** On
  `OPFSAnyContextVFS`, `IDBBatchAtomicVFS` and `IDBMirrorVFS` it used to resolve
  while a client was working and the data was gone — **silently on
  `IDBMirrorVFS`**, where the live client kept serving correct rows out of its
  in-memory mirror while a fresh client found an empty database. The four VFS
  that survived survived by accident, on an OPFS constraint this library never
  arranged, and reported `WORKER_CRASHED`. Every client now holds a lock for its
  lifetime and `deleteDatabase` refuses while any client holds it.
- **A second client on an `AccessHandlePoolVFS` database no longer opens and then
  silently fails to read anything.** Measured on both engines: it used to resolve
  `SELECT 1` and return `no such table` for every real table, and which of the two
  clients lost the OPFS handle race was non-deterministic — sometimes it was the
  first one, so opening a second tab could break the tab already working. The VFS
  now declares that it holds its storage exclusively, and a second client fails its
  first query with `BUSY` instead. Closing the first client releases it.
  **The error a second client receives changed** from `WORKER_CRASHED` or `TIMEOUT`
  to `BUSY`, and it now arrives immediately rather than after a stall.

### Known limitation, unchanged and now more visible

- **Serializing writers does not change which access handle a VFS holds.** Where
  `readwrite-unsafe` is unavailable, a read in another tab still waits for the
  rotated exclusive handle while a writer holds it.

### Documentation

No code changed. These are corrections to what the README told you to do.

- **A long-running *read* serializes other reads exactly as a write transaction
  does.** The README said it did not. Where one exclusive access handle is
  rotated between workers, the worker running the long statement holds it until
  the statement ends, whatever the statement is doing.
- **`OPFSWriteAheadVFS` is worth choosing outside Chromium after all**, where it
  was documented as buying nothing. It still serves no concurrent reads there —
  but it is faster than `OPFSAdaptiveVFS` on single writes, point reads, list
  pages, scans and transactions on both Firefox and Safari. Prefer it for a
  latency-bound workload, and `OPFSAdaptiveVFS` where reads must run alongside a
  long query. **Its reported failure to reopen a database on Safari 27 is
  withdrawn** — it did not reproduce.
- **`IDBBatchAtomicVFS` does not serve a read while a long query runs**, on any
  engine, though it remains the right answer for the two cases the VFS table's
  *Concurrent reads* column actually covers. `OPFSAnyContextVFS` is the only VFS
  here that serves one on every engine.

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
