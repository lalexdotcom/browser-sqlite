# Changelog

All notable changes to this project are documented here.

## Unreleased — 1.0.0-rc.4

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

### Fixed

- A write in a read-only transaction threw a bare `Error`, the only guard in the
  library that escaped the `code` discriminant.
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
