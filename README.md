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

[createSQLiteClient](#createsqliteclient) · [*client*.read](#clientread) · [*client*.write](#clientwrite) · [*client*.stream](#clientstream) · [*client*.chunk](#clientchunk) · [*client*.first](#clientfirst) · [*client*.transaction](#clienttransaction) · [*client*.bulkWrite](#clientbulkwrite) · [*client*.output](#clientoutput) · [*client*.inspect](#clientinspect) · [*client*.close](#clientclose) · [deleteDatabase](#deletedatabase) · [inspectDatabase](#inspectdatabase)

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

The client describes itself through five readonly properties, available whether or not `debug` is on:

| Property | Type | Description |
|---|---|---|
| `id` | `string` | A UUID minted for this client, unique across the origin. It is what tells two clients apart in [`inspectDatabase`](#inspectdatabase)'s roster. |
| `name` | `string` | The `name` option followed by this client's index in its tab — `"SQLite 1"` by default. It is the same string the `debug` logger prefixes its lines with. Two tabs can produce the same one; `id` is what cannot collide. |
| `file` | `string` | The database file, normalized. This is the identity every lock name is built on, and it may differ from the string you passed. |
| `vfs` | `SQLiteVFS` | The VFS this client opened with. |
| `build` | `SQLiteBuild` | The wa-sqlite build actually loaded — the VFS's first when `build` was not passed. |

They exist so that a module handed a client can describe it without also being handed the options it was created with.

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

**Pass values as `?` parameters rather than building them into the SQL.** Each worker keeps a
cache of 32 prepared statements, keyed on the exact SQL string. Interpolating a value makes
every call a new key, so nothing is ever reused: measured at **40 recompilations in 40
queries** once the distinct statements pass that bound, against **0** when they fit under it,
costing roughly 6 % on Chromium and 9 % on Firefox over a read-heavy loop. Generated SQL is
sometimes unavoidable — `IN (?, ?, ?)` changes shape with the list — and it still works; it
simply cannot be cached.

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

Await `enqueue()` to be slowed to the speed of the database. It resolves immediately while fewer than `queueSize` rows are queued for writing, and only defers beyond that — so a producer that awaits every row never holds more than that many unwritten rows. Ignoring the returned promise is legal and loads exactly as before: the bound is an offer, not a guarantee, and only you can take it. `queueSize` counts rows, not bytes: if your columns carry blobs, set it yourself.

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason`. |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

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
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

**Inside a transaction, `output()` costs more than it looks.** On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

### *client*.inspect

```typescript
const { self, siblings, tabs, write } = await db.inspect();
```

Reports who is live on this client's database, in every tab of the origin. It is the same census as [`inspectDatabase`](#inspectdatabase), where the semantics and the caveats are documented — the difference is only the split: `db.inspect()` separates `self`, this client's own entry, from `siblings`, everyone else, where `inspectDatabase` returns one `clients` list.

`self` is `null` when this client's own marker is not in the snapshot.

After `close()` it throws `CLIENT_CLOSED`, like every other method on the client. [`inspectDatabase`](#inspectdatabase) answers the same question afterwards — `inspectDatabase(db.file, { vfs: db.vfs })`, which is what those two properties are for.

### *client*.close

```typescript
await db.close();
```

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers. The returned promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed. Calling `close()` a second time returns the same promise — the operation runs exactly once.

**Stored data is not deleted.** `close()` releases workers and connections; it removes nothing. To remove the database itself, use [`deleteDatabase`](#deletedatabase).

**A page reload is not a close, and some engines make you wait for it.** Navigating away or
reloading discards the page without running `close()`, and the browser does not always release
the underlying connection at once — observed on iPadOS Safari 27, where the database stayed
held long enough for the next page's open to exhaust its full 30-second [`openTimeout`](#options)
and report `TIMEOUT`. If your application reloads while a client is open, close it first:
`window.addEventListener('pagehide', () => { void db.close(); })` is enough, and `pagehide`
fires where `unload` no longer does.

### deleteDatabase

Removes a database and the `-journal` / `-wal` files SQLite may have left beside it. The database must not be open, in this tab or any other.

```typescript
import { deleteDatabase } from 'browser-sqlite';

await deleteDatabase('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });
```

`vfs` is required and must be the VFS the database was created with. `build` and `wasmUrl` are accepted with the same meaning as on `createSQLiteClient`.

Deleting a database that is not there throws — most often because `vfs` is not the one it was created with.

What a VFS keeps for itself is left alone — the IndexedDB store shared by every database that VFS holds on this origin, and the `AccessHandlePoolVFS` directory whose files are its reusable capacity. The deleted database's own bytes are freed in both cases.

> **Warning:** `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` share one file per database name, so deleting through any of them deletes what the others created.

Throws `SQLiteError` with code `DATABASE_IN_USE` when a client still holds the database, in this tab or any other — retrying will not help, close every client on it first. `DATABASE_NOT_FOUND` means there was nothing at that name. `BUSY` is the transient case: another open or another delete was in flight at that moment, and retrying is the remedy. `TIMEOUT` means the VFS could not answer within 30 seconds; `OPFSWriteAheadVFS` and `OPFSCoopSyncVFS` have been seen doing that outside Chromium even with nothing open.

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite build to load. It does not affect where the database lives — only which builds can instantiate the VFS. |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Same meaning as on [`createSQLiteClient`](#options). A deployment that needs it to open a database needs it to delete one. |

### inspectDatabase

Reports who is live on a database, in every tab of the origin, **without opening it** — which is the point: the question usually arrives from code that holds no client, and nobody opens a database to learn that they cannot close it.

```typescript
import { inspectDatabase } from 'browser-sqlite';

const { clients, tabs, write } = await inspectDatabase('myapp.sqlite', {
  vfs: 'OPFSAdaptiveVFS',
});
```

`vfs` is required and must be the VFS the database was created with — four VFS share one file per database name, and the rest are separate stores, so the wrong one reports on a different database.

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. |

It resolves with the normalized `file`, the `vfs`, `clients`, `tabs` — the number of distinct tabs among them — and `write`.

| Field | Type | Description |
|---|---|---|
| `clients[].id` | `string` | The client's UUID, matching its own `db.id`. |
| `clients[].name` | `string` | The client's label with its index, e.g. `"SQLite 1"`. Not unique across tabs. |
| `clients[].tab` | `string` | The tab holding it. Every client in one tab reports the same value. |
| `clients[].sameTab` | `boolean` | That tab is the caller's. |
| `clients[].vfs` | `SQLiteVFS` | Which VFS it opened with — four of them share one file per database name. |
| `tabs` | `number` | Distinct tabs among `clients`. Not the same as `clients.length`. |
| `write.tab` | `string \| null` | The tab holding the write lock right now, or `null`. A tab, never a client: the lock's name is the mutex and carries no client identity. |
| `write.sameTab` | `boolean` | Always `false` when `write.tab` is `null`. |
| `write.waiting` | `number` | Writers queued behind it, across the whole origin. |

**"Tab" means realm.** A same-origin iframe in your own page is a different tab here: it has its own identity, so `sameTab` is `false` for it.

**A snapshot, never a permission.** It is stale the instant it resolves. An empty roster does not mean a database can be deleted — a tab may open between the two calls, and [`deleteDatabase`](#deletedatabase) raising `DATABASE_IN_USE` remains the only authority. An empty roster also does not distinguish a database nobody holds from one that does not exist; `DATABASE_NOT_FOUND` is what says that.

**Polling is on the call.** Nothing is kept between two calls, and there is no event to subscribe to. A call costs well under a tenth of a millisecond and makes no worker round trip; the tab's identity is resolved and cached once, so subsequent calls take no lock. Polling therefore cannot slow a query down, and 300–500 ms is a comfortable cadence. Do not stack calls: a background tab has its timers throttled, and an interval that fires without awaiting the previous answer will queue them up.

`MemoryVFS` and `MemoryAsyncVFS` throw `INVALID_OPTION`: their pages live in the worker that opened them, so two clients are two databases and there is nothing to share. Where the Web Locks API is missing, `inspectDatabase` and `db.inspect()` throw `UNSUPPORTED` rather than report zero.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2` | Number of Web Workers spawned in the pool. A larger pool allows more concurrent reads but uses more memory. Must be `1` with `AccessHandlePoolVFS`. **It also delays your first query**: nothing is served until every worker has opened, and the opens are serialized origin-wide, so the wait grows linearly with the pool — measured at roughly 7 ms per worker on Chromium and 20 ms on Firefox in one container, meaning `poolSize: 8` reached its first result in ~124 ms and ~204 ms where `poolSize: 1` took ~76 ms and ~68 ms. Measure your own targets before raising it. |
| `vfs` | `SQLiteVFS` | — (required) | VFS implementation for storage. See the [VFS Selection](#vfs-selection) table. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite WebAssembly build to load: `'sync'`, `'async'`, or `'jspi'`. Throws `INVALID_OPTION` at construction if the VFS does not support it. See [Builds](#builds). |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Where the workers fetch their `.wasm`. Omit it and resolution is unchanged: the files are read from beside `worker.js`. A string is a directory resolved against the page — relative, absolute or a full URL, trailing slash optional. A callback receives the resolved `build` and names one file, for a bundler-emitted asset carrying a content hash. Called once, at construction. Throws `INVALID_OPTION` there if the value is not a URL. Another origin needs CORS and `Content-Type: application/wasm`. |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. The counter resets once a replacement has actually served a request. A slot that fails to open is retried once, but only if another worker did open — when none did, the failure is a configuration error and the client fails immediately rather than retrying. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to post `ready` after `open` is sent. On expiry the slot is failed — the most common cause is a database held under an exclusive lock by another tab. **A pool that will never open takes up to twice this before your first query rejects**, because a slot that failed is retried once when another slot opens; at the default that is about a minute of waiting with nothing reported. Lower it if your application needs to fail faster than that. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run in the query generator's `finally` before the worker is presumed dead and the crash path is invoked. |
| `debug` | `string \| boolean` | `undefined` | Enables lifecycle logging. A string value is used as the log prefix; `true` falls back to the client name (e.g. `"SQLite 1"`). Only lifecycle events are logged — worker created, ready, open-error, crash, restart, worker lost, close, and skipped staging sweep. No line per query. Off by default, with one exception: a permanently lost worker always warns, because a pool quietly smaller than `poolSize` is not something to discover later. When enabled, `db.debug` also exposes a live introspection state tree for query throughput and worker status. |
| `onWorkerLost` | `(event: WorkerLostEvent) => void` | `undefined` | Called when a worker is lost for good, with the slot index, how many workers are left, the requested `poolSize`, and the error. Fires before the client fails if it was the last one. A throwing callback is caught and warned about; it cannot break the pool. |

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

| VFS | Builds | Browser compatibility | Pool size | Shared between connections | Survives close | Memory | Default PRAGMAs |
|-----|--------|-----------------------|-----------|----------------------------|----------------|--------|-----------------|
| `OPFSAdaptiveVFS` **(recommended)** | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `OPFSWriteAheadVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+/27+ [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `OPFSCoopSyncVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `AccessHandlePoolVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+/27+ | **1** — it cannot share access handles between connections | No | Yes | Page cache only, bounded by `PRAGMA cache_size` | `locking_mode=exclusive`<br>`journal_mode=wal` |
| `IDBBatchAtomicVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `IDBMirrorVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright | No | Yes | **Whole database in RAM**, multiplied by `poolSize` | — |
| `OPFSAnyContextVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 26+/27+<br>Android 109+/?<br>iOS 26+/27+ | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` | — |
| `MemoryVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` | — |
| `MemoryAsyncVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+/27+ | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` | — |

<!-- END GENERATED VFS TABLE -->

The **Browser compatibility** column is derived from documented platform support,
not from our own test runs. It covers where the VFS stores data; which **builds**
are reachable on each engine is a separate question, answered under
[Builds](#builds) — the `Builds` column links straight to the build it names.

On **`IDBBatchAtomicVFS`** the **Memory** column is not the whole story:
`PRAGMA cache_size` also decides whether a transaction runs in IndexedDB's
batch-atomic mode. The VFS takes that path only when the cache can hold the
transaction's pages, and falls back silently when it cannot — at SQLite's
default of `-2000` a 5000-page transaction never enters it, on either engine.
Raising the bound reserves nothing up front; the heap grows only as the workload
uses it. **This library sets no default for it**, because raising it saved no
time in either engine — so this is something to know about your own workload,
not a knob to turn on principle.

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

**A long *read* does not produce this effect, except once per worker after a
write.**

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
| `BUSY` | A transient conflict, worth retrying. Either SQLite reported a lock conflict — `SQLITE_BUSY` or `SQLITE_LOCKED`, with the numeric code on `sqliteCode` — or a database was being opened or deleted elsewhere at that moment. **A read that SQLite reported busy is retried once for you**; if it reaches you, the retry failed too. Writes are never retried, and neither is a `BUSY` without a `sqliteCode`. |
| `DATABASE_IN_USE` | A client still holds the database, in this tab or another. Retrying will not help: close every client on it first. Raised by `deleteDatabase`, and by any method on a second client where the VFS supports one connection at a time. |
| `DATABASE_NOT_FOUND` | There is nothing at that name to delete. Raised by `deleteDatabase` alone — `createSQLiteClient` creates a database that is absent, so it has no such case. The likeliest cause is a `vfs` that is not the one the database was created with. |
| `UNSUPPORTED` | The platform cannot answer. Raised by `inspectDatabase` and `db.inspect()` where the Web Locks API is unavailable — reporting zero clients there would be indistinguishable from a database nobody holds. |
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

**It holds across tabs too, except on `IDBMirrorVFS`.** A commit in any tab is
observed by the next read in every other tab on the same database. The exception
cannot be fixed here: `IDBMirrorVFS` mirrors the whole database in memory per
worker and propagates commits asynchronously, so a connection whose mirror has
not caught up has nothing fresher to read.

**Writes are serialized between clients and between tabs.** A write, a write
transaction, and each batch of a `bulkWrite` take one lock per database across
the whole origin, so a second writer **waits** rather than failing. The wait is
unbounded and first-come-first-served: pass a `signal` if you would rather fail
than wait. A write transaction holds that lock for the whole of its callback, so
a callback that never returns blocks every other writer in the origin, not only
its own client.

## Requirements

browser-sqlite requires no special HTTP headers. OPFS access handles work in a plain worker context; cross-origin isolation is not needed. The default build needs no browser opt-in; only `build: 'jspi'` does, and that is an unrelated browser constraint, not a header requirement.

Note: the "Coop" in `OPFSCoopSyncVFS` stands for *cooperative*, not the `Cross-Origin-Opener-Policy` header.

## Known Limitations

- **`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.
- **`AccessHandlePoolVFS` allows one connection per origin, not one per tab.** A second client on the same database — in this tab or another — fails its first query with `BUSY`, immediately. Close the first client and the next one opens. This is the one VFS where two tabs cannot share a database at all, so choose another if your application expects to be open twice.
- **`build: 'jspi'` is not available everywhere.** The [`jspi` build table](#build-jspi) carries the per-engine versions; it is generated, so it is the one place that stays current. The build is opt-in and no default uses it, so this constrains nobody who does not ask for it.
- **`OPFSWriteAheadVFS` buys you nothing outside Chromium.** It opens access handles with `mode: 'readwrite-unsafe'`, which Firefox and Safari do not support — and which they ignore rather than reject, so it still works but falls back to the same reduced mode as `OPFSAdaptiveVFS` and serves no concurrent reads there. On **Safari 27 the `sync` build can also fail to reopen a database** — seen once in three runs, on macOS and on iPadOS. Use `OPFSAdaptiveVFS` outside Chromium.
- **`OPFSCoopSyncVFS` does not read concurrently, and stalls unpredictably under a pool.** Unlike the other OPFS VFS it implements its own locking and silently ignores the `lockPolicy: 'shared'` this library constructs every VFS with, holding one *exclusive* access handle and rotating it between workers instead of one per connection. A read issued while a write transaction is open is **never served** — the pool acquisition blocks before any `AbortSignal` is consulted — where `IDBBatchAtomicVFS`, `IDBMirrorVFS` and `OPFSAnyContextVFS` serve it every time. A bulk insert either finishes promptly or **exceeds 30 seconds**, with no middle ground and no consistency across runs. None of this depends on `readwrite-unsafe`: unlike the reduced mode described above, it happens on Chromium too.
- **Read-your-own-writes holds across tabs, except on `IDBMirrorVFS`.** See the
  caveat under [Error handling](#error-handling).
- **Writes are serialized across clients and tabs; reads are not.** A second writer waits rather than failing, on every VFS and every browser. **Pass a `signal` if you would rather fail than wait** — the wait is otherwise unbounded, though first-come-first-served. A write transaction holds the lock for the whole of its callback, so a callback that never returns blocks every other writer in the origin, not only its own client. **A `bulkWrite` takes the lock per batch and commits per batch**, so another client's write can land between two of its batches, and abandoning one leaves a partial load rather than a failed one: everything before is in the database, and one further batch may still land after you gave up — the one already handed to a worker, which no signal can recall. Use `tx.bulkWrite` where you need all or nothing.
- **Reads still wait on the file where your browser gives you one access handle.** Serializing writers does not change which handle a VFS holds. Where `readwrite-unsafe` is unavailable, a read in another tab still waits for the rotated exclusive handle while a writer holds it.
- **A database that any client still holds cannot be deleted**, in this tab or another, on every VFS. `deleteDatabase` reports `DATABASE_IN_USE` immediately rather than deleting under a live connection, and reports `BUSY` when an open or another delete is merely in flight — the first means close it, the second means retry. **Closing every client on the database is what releases it**, so a client your application has stopped using but never closed keeps blocking until its tab goes. This library cannot revoke a connection it did not open: another library or native code on the same origin is invisible to it.
- **`deleteDatabase` can time out outside Chromium**, on `OPFSWriteAheadVFS` and `OPFSCoopSyncVFS` — an observation rather than a measured rate. The call fails to settle rather than reporting an error; it has never reported success without deleting. Both VFS rotate a single exclusive OPFS access handle where `readwrite-unsafe` is unavailable, the same shape as the reduced mode described above.

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
