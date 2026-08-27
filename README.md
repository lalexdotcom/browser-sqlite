# browser-sqlite

A persistent SQLite database that lives in your browser — yes, for real. Powered by [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (WebAssembly), built for (read) concurrency.

**▶ [Run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)** — every
VFS this library ships, put through the same conformance checks and measurements, on your device.
It is the honest way to choose one: which VFS wins depends on the engine, and it changes often —
a single browser release can move the answer.

## Install

```bash
npm install browser-sqlite
# or
pnpm add browser-sqlite
```

Requires a bundler that supports Web Workers with dynamic imports — or no bundler at all.

## Bundler Configuration

Works with no configuration under **rsbuild 1+**, **rspack 1+**, **Parcel 2+**, **Vite 8+**, **webpack 5.101+** — and with no bundler at all.

Works under **Vite 6.1 to 7** with the following config, which only the dev server needs:

```typescript
// vite.config.ts
export default defineConfig({
  optimizeDeps: { exclude: ['browser-sqlite'] },
});
```

Another bundler will likely work — the worker and its `.wasm` are reached through plain, statically analysable URLs — but may need configuration of its own.

The `.wasm` are read from beside `worker.js`. If a build separates them, or you move them by hand, point at them with [`wasmUrl`](#options).

## Usage

[createSQLiteClient](#createsqliteclient) · [*client*.read](#clientread) · [*client*.write](#clientwrite) · [*client*.stream](#clientstream) · [*client*.chunk](#clientchunk) · [*client*.first](#clientfirst) · [*client*.transaction](#clienttransaction) · [*client*.bulkWrite](#clientbulkwrite) · [*client*.output](#clientoutput) · [*client*.close](#clientclose) · [deleteDatabase](#deletedatabase)

### createSQLiteClient

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient('myapp.sqlite', {
  poolSize: 2,                    // number of worker threads (default: 2)
  vfs: 'OPFSAdaptiveVFS',         // required — see VFS Selection
  build: 'async',                 // wa-sqlite build (default: the VFS's first)
  pragmas: {                      // SQLite PRAGMAs applied on open
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
  },
});
```

`createSQLiteClient` spawns `poolSize` Web Worker threads immediately. Workers reach READY state asynchronously — queries made before workers are ready are queued automatically.

Every option is listed under [Options](#options). `vfs` is the one with no default — [VFS Selection](#vfs-selection) is how to choose it, and a database written through one VFS is not readable through another.

### *client*.read

```typescript
type User = { id: number; name: string };

const users = await db.read<User>(
  'SELECT id, name FROM users WHERE active = ?',
  [1],
);
// users: User[]
```

Read queries are dispatched to any available worker, enabling concurrent reads.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

On `read()` this is transport only — it still resolves with the whole array.

### *client*.write

```typescript
const { affected } = await db.write(
  'INSERT INTO users (name, email) VALUES (?, ?)',
  ['Alice', 'alice@example.com'],
);
// affected: number of rows inserted
```

Write queries are serialized through a dedicated writer worker — only one write executes at a time.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. |

### *client*.stream

```typescript
// Worker is held for the full generator lifetime — always exhaust or break.
for await (const row of db.stream<User>('SELECT * FROM large_table', [])) {
  processRow(row); // row is User
}
```

`stream()` yields individual rows without buffering the full result set in memory.
Use `chunk()` to iterate in batches: `for await (const rows of db.chunk(...))`.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

On `stream()`, `chunkSize` is the only lever on how many rows are in flight.

### *client*.chunk

```typescript
// Worker is held for the full generator lifetime — always exhaust or break.
for await (const rows of db.chunk<User>('SELECT * FROM large_table', [])) {
  processBatch(rows); // rows is User[]
}
```

`chunk()` yields arrays instead of rows. Prefer it over `stream()` when the work
is per-batch — one `INSERT` per chunk rather than per row.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

Here `chunkSize` is the batch size the consumer sees, not only a transport detail.

### *client*.first

```typescript
const user = await db.first<User>(
  'SELECT * FROM users WHERE id = ?',
  [42],
);
// user: User | undefined
```

`first()` returns the first result row, or `undefined` if no rows match. Use it for lookups by primary key or unique field.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. |

`first()` stops the query after one row instead of draining the result set.

### *client*.transaction

```typescript
const orders = await db.transaction(async (tx) => {
  await tx.write('INSERT INTO orders (id, total) VALUES (?, ?)', [1, 42]);
  await tx.write('UPDATE stock SET qty = qty - 1 WHERE id = ?', [7]);
  const rows = await tx.read<{ n: number }>('SELECT count(*) AS n FROM orders');
  return rows[0].n;
});
```

One worker is held for the callback's whole lifetime, so nothing else can run on
it: the transaction is genuinely isolated, not merely wrapped in `BEGIN`.
Returning commits, throwing rolls back and re-throws. `{ readOnly: true }`
rejects write statements; `{ autoCommit: false }` leaves the commit to you.

`tx` carries the same querying surface as the client — `read`, `write`, `chunk`, `stream`, `first`, `bulkWrite`, `output` — plus `commit` and `rollback`.

`{ signal }` abandons the transaction at any point, including while it waits for a worker and while your callback sits on something that is not a statement. It rolls back and rejects with `signal.reason`, and it never commits — a callback that catches its own statement's rejection cannot commit around the abort. Your callback is not interrupted, but every statement it issues afterwards rejects. `BEGIN`, `COMMIT` and `ROLLBACK` are the exception: they do not carry the signal, so an abort raised while one of them is in flight lands when it settles.

| Option | Type | Default | Description |
|---|---|---|---|
| `readOnly` | `boolean` | `false` | Rejects write statements with `READ_ONLY_TRANSACTION`, at the call rather than at the first flush. |
| `autoCommit` | `boolean` | `true` | Commits when the callback resolves. Set it false to commit or roll back yourself. |
| `signal` | `AbortSignal` | — | Abandons the transaction. Rolls back and rejects with `signal.reason`; never commits. |

### *client*.bulkWrite

```typescript
const rows = db.bulkWrite('events', ['id', 'kind', 'at']);
for (const event of events) rows.enqueue(event);
const affected = await rows.close();
```

Batches inserts to stay under SQLite's variable limit (`SQLITE_MAX_VARS`,
32 766), flushing whenever the next row would cross it. `close()` flushes the
remainder and resolves with the total number of rows written.

Single-use: `enqueue()` and `close()` throw once closed. A batch that fails
rejects with a `SQLiteBulkWriteError` carrying `rowsWritten` and `rowsNotWritten` — a
multi-row INSERT is statement-atomic, so the failing batch wrote nothing.

`bulkWrite()` is not atomic: batches are committed as they flush, so a failure leaves the rows already written in place. Call it on a `tx` if you need all-or-nothing.

Pass `{ signal }` to abort a load. `close()` then rejects with `signal.reason`, and the abort lands **between** batches — never inside one, because a multi-row INSERT is statement-atomic. The batches already written stay written, for the same reason a failure leaves them: an abort stops the load, it does not undo it.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason`. |

### *client*.output

```typescript
const out = db.output(
  'products',
  { id: 'INTEGER', name: 'TEXT', price: { type: 'REAL', required: true } },
  { indexes: ['name', { columns: ['name', 'price'], unique: true }] },
);
out.enqueue({ id: 1, name: 'widget', price: 9.99 });
const affected = await out.close();
```

Builds a table from a schema declaration and populates it. Rows land in a
staging table and the swap happens atomically at `close()`, so **the previous
table stays intact and fully populated until the new one is ready** — a reader
querying mid-load sees the old data, never a half-filled table. A target that
did not exist appears only at `close()`. Single-use, like `bulkWrite`.

`output()` takes `{ signal }` too, and an aborted one is observationally a no-op: the staging table is dropped and nothing else is touched. No rename, no partial publication — whatever was in the target before is still there, whole.

| Option | Type | Default | Description |
|---|---|---|---|
| `indexes` | `Index[]` | — | Indexes built after the swap, under their final names. A column name, an array of them, or `{ columns, unique }`. |
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason` and the target is untouched. |

**Inside a transaction, `output()` costs more than it looks.** On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

### *client*.close

```typescript
await db.close();
```

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers. The returned promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed. Calling `close()` a second time returns the same promise — the operation runs exactly once.

**Stored data is not deleted.** `close()` releases workers and connections; it removes nothing. To remove the database itself, use [`deleteDatabase`](#deletedatabase).

### deleteDatabase

Removes a database and the `-journal` / `-wal` files SQLite may have left beside it. The database must not be open, in this tab or any other.

```typescript
import { deleteDatabase } from 'browser-sqlite';

await deleteDatabase('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });
```

`vfs` is required and must be the VFS the database was created with: a database written through one VFS is not visible through another, so deleting through the wrong one deletes nothing and reports success. `build` and `wasmUrl` are accepted with the same meaning as on `createSQLiteClient`.

Deleting a database that does not exist is not an error.

What a VFS keeps for itself is left alone — the IndexedDB store shared by every database that VFS holds on this origin, and the `AccessHandlePoolVFS` directory whose files are its reusable capacity. The deleted database's own bytes are freed in both cases.

Throws `SQLiteError` with code `BUSY` when the database is open or being opened, and `TIMEOUT` when the VFS cannot answer within 30 seconds — most often the same cause.

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. Deleting through another one deletes nothing and reports success. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite build to load. It does not affect where the database lives — only which builds can instantiate the VFS. |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Same meaning as on [`createSQLiteClient`](#options). A deployment that needs it to open a database needs it to delete one. |

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2` | Number of Web Workers spawned in the pool. A larger pool allows more concurrent reads but uses more memory. Must be `1` with `AccessHandlePoolVFS`. |
| `vfs` | `SQLiteVFS` | — (required) | VFS implementation for storage. See the [VFS Selection](#vfs-selection) table. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite WebAssembly build to load: `'sync'`, `'async'`, or `'jspi'`. Throws `INVALID_OPTION` at construction if the VFS does not support it. See [Builds](#builds). |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Where the workers fetch their `.wasm`. Omit it and resolution is unchanged: the files are read from beside `worker.js`. A string is a directory resolved against the page — relative, absolute or a full URL, trailing slash optional. A callback receives the resolved `build` and names one file, for a bundler-emitted asset carrying a content hash. Called once, at construction. Throws `INVALID_OPTION` there if the value is not a URL. Another origin needs CORS and `Content-Type: application/wasm`. |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. A slot that never reached readiness is never restarted — an initial failure is deterministic and restarting only delays the diagnostic. The counter resets once a replacement has actually served a request. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to post `ready` after `open` is sent. On expiry the slot is failed — the most common cause is a database held under an exclusive lock by another tab. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run in the query generator's `finally` before the worker is presumed dead and the crash path is invoked. |
| `debug` | `string \| boolean` | `undefined` | Enables lifecycle logging. A string value is used as the log prefix; `true` falls back to the client prefix (e.g. `"SQLite 1"`). Only lifecycle events are logged — worker created, ready, open-error, crash, restart, eviction, close, and skipped staging sweep. No line per query. Off by default. When enabled, `db.debug` also exposes a live introspection state tree for query throughput and worker status. |

## Browser support

| Chrome | Firefox | Safari |
|---|---|---|
| 92+ | 95+ | 15.4+ |

## VFS Selection

browser-sqlite delegates storage to a
[wa-sqlite Virtual File System](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#readme)
(VFS).

**`vfs` is required — there is no default.** A VFS decides *where* your database
is written, so a default that moved between versions would leave you reading an
empty database while your bytes sat in a store nothing queries.

**Pass `OPFSAdaptiveVFS` unless you have a reason not to.** Across every engine we
could test — Chrome, Firefox and Safari, desktop and mobile — it opened and passed
every conformance check without exception. It is the only VFS here of which that is
true.

> **Each VFS is a separate store.** A database written through one VFS is not
> visible through another — the bytes are still there, but nothing reads them.
> Changing `vfs` later does not migrate anything.

You would leave that choice when you control which browser runs your code — an
Electron app, a kiosk, a managed fleet — and need something it cannot give you:

| Browser you can guarantee | Concurrent reads | Write-heavy workloads |
|---|---|---|
| None — the open web | `OPFSAnyContextVFS` if you can require Safari 26+; otherwise `IDBBatchAtomicVFS` | stay on `OPFSAdaptiveVFS` |
| Chromium 121+ | already the case | `OPFSWriteAheadVFS` |
| Firefox 111+ | `OPFSAnyContextVFS` | stay |
| Safari 26+ / iPadOS 26+ | `OPFSAnyContextVFS` | stay |
| iOS (iPhone) | none measured to help | stay |

**Concurrent reads** covers both serving a read while a write transaction is open
and running several reads at once under a pool: a VFS holding one exclusive
access handle can do neither, because it is the same handle a second worker never
gets. For how much any of this is worth on your own targets, run
[the benchmark page](https://lalexdotcom.github.io/browser-sqlite/) — no timings
appear in this file.

<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->

| VFS | Builds | Browser compatibility | Pool size | Shared between connections | Survives close | Memory |
|-----|--------|-----------------------|-----------|----------------------------|----------------|--------|
| `OPFSAdaptiveVFS` **(recommended)** | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSWriteAheadVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSCoopSyncVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `AccessHandlePoolVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | **1** — it cannot share access handles between connections | No | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBBatchAtomicVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBMirrorVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright | No | Yes | **Whole database in RAM**, multiplied by `poolSize` |
| `OPFSAnyContextVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 26+/27+<br>Android 109+/?<br>iOS 26+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `MemoryVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |
| `MemoryAsyncVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |

<!-- END GENERATED VFS TABLE -->

The **Browser compatibility** column is derived from documented platform support,
not from our own test runs. It covers where the VFS stores data; which **builds**
are reachable on each engine is a separate question, answered under
[Builds](#builds) — the `Builds` column links straight to the build it names.

#### (*) Reduced mode

The VFS runs on that engine, but without `readwrite-unsafe` access handles: one
exclusive handle rotated between workers instead of one held per connection. It
is not a partial failure — `OPFSAdaptiveVFS` passes 102 of 104 browser tests on
Firefox in exactly that mode.

What it costs is pool concurrency under one specific shape. **On an engine
without `readwrite-unsafe`, a VFS that rotates a single exclusive OPFS access
handle cannot serve any other worker while a write transaction holds that
handle** — the worker that took it does not give it back before the transaction
ends, and the next acquisition blocks in the scheduler, before an `AbortSignal`
is ever consulted. That covers `OPFSAdaptiveVFS` in reduced mode.
`IDBMirrorVFS`, `OPFSAnyContextVFS` and `IDBBatchAtomicVFS` hold no such handle
and are unaffected.

`OPFSCoopSyncVFS` has the same symptom for a different reason, and it is **not**
conditional on the engine — it never uses `readwrite-unsafe`, so it is never in
reduced mode. See [Known Limitations](#known-limitations).

**A long *read* does not produce this effect.** A statement that holds the
file's read lock for several seconds does not delay short reads on the other
workers: measured on Firefox, they still return in about a millisecond, where a
stranded pool would put them in the seconds. The blocking is specific to the
write's exclusive acquisition, not to the statement's duration — an earlier
revision of this section claimed the broader form, and measurement narrowed it.

Both halves are measured by `scripts/bench/html/index.html`, which runs in your own browser;
its `no-read-inside-transaction` and `pool-blocking` rows are the two
observations above.

#### `OPFSAnyContextVFS` and wa-sqlite

This VFS needs a patched wa-sqlite to work on Safari. browser-sqlite ships that
patch inside its own worker bundle — there is nothing for you to install or
configure.

### Builds

Each VFS runs on one or more wa-sqlite WebAssembly builds. The `build` option
selects one; omitted, the first build the VFS declares is used — `async` for the
default VFS. A pair the VFS does not support throws a `SQLiteError` with code
`INVALID_OPTION` at construction, naming the builds it does support. The pairing
is declared in one place, `VFS_CAPABILITIES`, which is also what the `SQLiteVFS`
type is derived from.

A build carries its own engine requirement, independent of where the VFS stores
data — so a VFS can be reachable in `sync` on an old browser and in `jspi` only
on a much newer one.

<!-- BEGIN GENERATED BUILD TABLE — edit FEATURE_SUPPORT in scripts/render-vfs-matrix.ts -->

#### Build `sync`

| Chrome / Edge | Firefox | Safari | Chrome Android | Safari iOS |
|---|---|---|---|---|
| Any | Any | Any | Any | Any |

Plain synchronous WebAssembly. Needs nothing beyond baseline WASM, so it runs anywhere — but only VFS whose file operations are all synchronous can offer it.

#### Build `async`

| Chrome / Edge | Firefox | Safari | Chrome Android | Safari iOS |
|---|---|---|---|---|
| Any | Any | Any | Any | Any |

Asyncify: the WASM stack is unwound and rewound around asynchronous file operations. Also needs nothing beyond baseline WASM. This is the default, and every VFS here can run on it.

#### Build `jspi`

| Chrome / Edge | Firefox | Safari | Chrome Android | Safari iOS |
|---|---|---|---|---|
| 137+ | 153+ | 27+ | Yes | 27+ |

JavaScript Promise Integration — the same asynchrony handled by the engine rather than by Asyncify. Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it.


<!-- END GENERATED BUILD TABLE -->

## Error handling

Errors raised by this library are instances of `SQLiteError`, exported from the package entry point. Discriminate on `error.code` or `error.name` — they carry the same value, so `err.name` reads the way `'AbortError'` does on a DOM `AbortError`.

| Code | When it is thrown |
|------|------------------|
| `NOT_A_READ_QUERY` | `read()`, `chunk()`, `stream()`, or `first()` was called with a statement that is not a provably readable query. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument must go through `write()`. |
| `CLIENT_CLOSED` | A query was queued after `close()` was called. |
| `WORKER_CRASHED` | A pool worker died and the supervisor decided not to restart it. All queued and in-flight work on that slot is rejected. |
| `TIMEOUT` | A worker did not post `ready` within `openTimeout` milliseconds. The most common cause is a database held under an exclusive lock by another tab or client. |
| `PROTOCOL_ERROR` | A message was received from a worker that could not be deserialized (`messageerror`). The worker survives; only the in-flight request is rejected. |
| `BUSY` | SQLite reported a lock conflict (`SQLITE_BUSY` or `SQLITE_LOCKED`); the numeric SQLite code is on `sqliteCode`. The operation is not retried. |
| `READ_ONLY_TRANSACTION` | raised when a write statement, `bulkWrite()` or `output()` is used inside a transaction opened with `readOnly: true`. |

```typescript
import { SQLiteError } from 'browser-sqlite';

try {
  await db.write('...');
} catch (err) {
  if (err instanceof SQLiteError) {
    switch (err.code) {
      case 'WORKER_CRASHED': /* restart or notify */ break;
      case 'CLIENT_CLOSED':  /* client was shut down */ break;
    }
  }
}
```

**Request timeouts.** The library adds no per-request timeout. To bound a query, pass `AbortSignal.timeout(ms)`:

```typescript
const rows = await db.read('SELECT * FROM large_table', [], {
  signal: AbortSignal.timeout(5_000),
});
```

**`close()` is async.** Always `await db.close()` — the returned promise settles once every worker has closed its database connection and been terminated. Discarding the promise means the caller cannot tell when teardown is complete.

**Read methods reject write statements.** `read()`, `chunk()`, `stream()`, and `first()` reject any statement that is not a provably readable query, throwing `NOT_A_READ_QUERY`. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument must go through `write()`.

**Read-your-own-writes is guaranteed within a tab.** Once a write has resolved,
any read issued afterwards — from that client or from any other client in the
same tab on the same database — observes it, whatever the pool size. A worker
that has not yet observed the latest commit runs one discarded statement that
opens a real read transaction before it serves the query; that costs one extra
worker round-trip on each worker's first statement after a write, and nothing
under read-only load. `poolSize: 1` and reading inside the same `transaction()`
remain valid, they are no longer required.

**It is not guaranteed across tabs.** A write in one tab may not be visible to a
read in another. No bound is claimed on how long that lasts.

**Nothing serializes writes between clients.** Two clients writing to one
database concurrently can fail on a lock; the failure surfaces as
`SQLiteError` with code `BUSY` and `sqliteCode` 5 or 6, and it is **not**
retried — no `busy_timeout` is applied. This was true before the guarantee
above existed; it matters now because the guarantee makes several clients on
one database a reasonable thing to do.

## Requirements

browser-sqlite requires no special HTTP headers. OPFS access handles work in a plain worker context; cross-origin isolation is not needed. The default build needs no browser opt-in; only `build: 'jspi'` does, and that is an unrelated browser constraint, not a header requirement.

Note: the "Coop" in `OPFSCoopSyncVFS` stands for *cooperative*, not the `Cross-Origin-Opener-Policy` header.

## Known Limitations

- **`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.
- **`build: 'jspi'` is not available everywhere.** The [`jspi` build table](#build-jspi) carries the per-engine versions; it is generated, so it is the one place that stays current. The build is opt-in and no default uses it, so this constrains nobody who does not ask for it.
- **`OPFSWriteAheadVFS` buys you nothing outside Chromium.** It opens access handles with `mode: 'readwrite-unsafe'`, recorded as unsupported for Firefox and Safari in MDN browser-compat-data (checked 2026-08-24), and unknown dictionary members are ignored rather than rejected. Without that mode it still works — it passes every conformance check on Firefox 153, and on Safari 26.6, 27.0 and iPadOS 27.0 (measured 2026-08-27) — but it falls back to the same reduced mode as `OPFSAdaptiveVFS` and serves no concurrent reads there. On **Safari 27 the `sync` build additionally fails to reopen a database**, on macOS and iPadOS alike. Use `OPFSAdaptiveVFS` outside Chromium.
- **`OPFSCoopSyncVFS` does not read concurrently, and stalls unpredictably under a pool.** Unlike the other OPFS VFS it extends `FacadeVFS` directly rather than `WebLocksMixin(FacadeVFS)` (wa-sqlite v1.1.2, `src/examples/OPFSCoopSyncVFS.js:44` against `OPFSAdaptiveVFS.js:55`), so it implements its own locking and silently ignores the `lockPolicy: 'shared'` this library constructs every VFS with. It holds one *exclusive* access handle and rotates it between workers instead of holding one per connection. Measured with `scripts/bench/html/index.html` on 2026-08-25 at `poolSize: 4`, Chromium 151 and Firefox 153: a read issued while a write transaction is open is **never served on either engine** — the pool acquisition blocks before any `AbortSignal` is consulted — where `IDBBatchAtomicVFS`, `IDBMirrorVFS` and `OPFSAnyContextVFS` serve it every time. Its bulk insert of 10 000 rows either finishes in about 70–90 ms or **exceeds 30 seconds**, with no middle ground and no consistency across builds or runs; on both engines it stranded whole benchmark columns on that row. None of this depends on `readwrite-unsafe`: unlike the reduced mode described above, it happens on Chromium too.
- **Read-your-own-writes is guaranteed within a tab, not across tabs.** See the
  caveat under [Error handling](#error-handling).
- **A database that is open cannot be deleted**, in this tab or another. `deleteDatabase` takes the same origin-wide lock a client takes while opening, which prevents an open from interleaving with a delete, and reports `BUSY` rather than deleting under a live connection. A connection that already holds its handles cannot be revoked from this library — close every client on the database first.

## Development

```bash
pnpm install
pnpm build          # rslib → dist/
pnpm test           # unit (Node) + browser (Playwright/Chromium)
pnpm check          # biome, with --write
```

Two suites run on demand rather than on every change:

```bash
pnpm test:conformance   # every declared (vfs, build) pair through six invariants
pnpm test:consumer      # packs the tarball and drives four bundler modes
```

### The benchmark page

`scripts/bench/html/index.html` is the page published above. It is one self-contained file
served beside a verbatim copy of `dist/`, so it exercises the library exactly as
a consumer would with no bundler at all.

```bash
pnpm bench:dev      # build, serve on http://127.0.0.1:8099, rebuild on change
pnpm bench:serve    # same without the watch
pnpm bench:build    # assemble _site/ only
```

`http://127.0.0.1` is a secure context, so OPFS works with no certificate — no
TLS setup is needed to develop against it. A phone on the LAN is a different
matter: it is not a secure context, so OPFS is unavailable there and a tunnel
(or the published page) is the way to test a real device.

`node scripts/bench/check.mjs [chromium|firefox] [--all]` drives the page under
Playwright and asserts that it still works — it is run by hand and deliberately
not wired into CI. It checks the *page*, never that a VFS passes: a red cell can
be a correct report about the engine you are on.
