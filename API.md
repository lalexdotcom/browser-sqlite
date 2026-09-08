# API

Every method, property and option of [browser-sqlite](README.md).

[*client*.id](#clientid) · [*client*.name](#clientname) · [*client*.file](#clientfile) · [*client*.vfs](#clientvfs) · [*client*.build](#clientbuild)

[createSQLiteClient()](#createsqliteclient) · [*client*.read()](#clientread) · [*client*.write()](#clientwrite) · [*client*.stream()](#clientstream) · [*client*.chunk()](#clientchunk) · [*client*.first()](#clientfirst) · [*client*.transaction()](#clienttransaction) · [*client*.bulkWrite()](#clientbulkwrite) · [*client*.output()](#clientoutput) · [*client*.inspect()](#clientinspect) · [*client*.close()](#clientclose) · [deleteDatabase()](#deletedatabase) · [inspectDatabase()](#inspectdatabase)

## createSQLiteClient

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

`vfs` is the only option with no default — [VFS Selection](VFS.md#vfs-selection) is how to choose it, and a database written through one VFS is not readable through another.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2`, or the VFS's maximum when it is lower | Number of Web Workers spawned in the pool. A larger pool allows more concurrent reads but uses more memory. A VFS that holds a single connection caps it at `1` and throws if you pass more; omitting it never throws, because the default is capped to what the VFS allows. **It also delays your first query**: nothing is served until every worker has opened, and the opens are serialized origin-wide, so the wait grows linearly with the pool — measured at roughly 7 ms per worker on Chromium and 20 ms on Firefox in one container, meaning `poolSize: 8` reached its first result in ~124 ms and ~204 ms where `poolSize: 1` took ~76 ms and ~68 ms. Measure your own targets before raising it. |
| `vfs` | `SQLiteVFS` | — (required) | VFS implementation for storage. See the [VFS Selection](VFS.md#vfs-selection) table. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite WebAssembly build to load: `'sync'`, `'async'`, or `'jspi'`. Throws `INVALID_OPTION` at construction if the VFS does not support it. See [Builds](VFS.md#builds). |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Where the workers fetch their `.wasm`. Omit it and resolution is unchanged: the files are read from beside `worker.js`. A string is a directory resolved against the page — relative, absolute or a full URL, trailing slash optional. A callback receives the resolved `build` and names one file, for a bundler-emitted asset carrying a content hash. Called once, at construction. Throws `INVALID_OPTION` there if the value is not a URL. Another origin needs CORS and `Content-Type: application/wasm`. |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. The counter resets once a replacement has actually served a request. A slot that fails to open is retried once, but only if another worker did open — when none did, the failure is a configuration error and the client fails immediately rather than retrying. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to post `ready` after `open` is sent. On expiry the slot is failed — the most common cause is a database held under an exclusive lock by another tab. **A pool that will never open takes up to twice this before your first query rejects**, because a slot that failed is retried once when another slot opens; at the default that is about a minute of waiting with nothing reported. Lower it if your application needs to fail faster than that. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run in the query generator's `finally` before the worker is presumed dead and the crash path is invoked. |
| `debug` | `string \| boolean` | `undefined` | Enables lifecycle logging. A string value is used as the log prefix; `true` falls back to the client name (e.g. `"SQLite 1"`). Only lifecycle events are logged — worker created, ready, open-error, crash, restart, worker lost, close, and skipped staging sweep. No line per query. Off by default, with one exception: a permanently lost worker always warns, because a pool quietly smaller than `poolSize` is not something to discover later. When enabled, `db.debug` also exposes a live introspection state tree for query throughput and worker status. |
| `onWorkerLost` | `(event: WorkerLostEvent) => void` | `undefined` | Called when a worker is lost for good, with the slot index, how many workers are left, the requested `poolSize`, and the error. Fires before the client fails if it was the last one. A throwing callback is caught and warned about; it cannot break the pool. |

## *client*.id

`string`, readonly. A UUID minted for this client, unique across the origin. It is what tells two clients apart in [`inspectDatabase`](#inspectdatabase)'s roster.

## *client*.name

`string`, readonly. The `name` option followed by this client's index in its tab — `"SQLite 1"` by default. It is the same string the `debug` logger prefixes its lines with. Two tabs can produce the same one; `id` is what cannot collide.

## *client*.file

`string`, readonly. The database file, normalized. This is the identity every lock name is built on, and it may differ from the string you passed.

## *client*.vfs

`SQLiteVFS`, readonly. The VFS this client opened with.

## *client*.build

`SQLiteBuild`, readonly. The wa-sqlite build actually loaded — the VFS's first when `build` was not passed.

## *client*.read

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
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

On `read()` this is transport only — it still resolves with the whole array.

**Pass values as `?` parameters rather than building them into the SQL.** Each worker keeps a
cache of 32 prepared statements, keyed on the exact SQL string. Interpolating a value makes
every call a new key, so nothing is ever reused: measured at **40 recompilations in 40
queries** once the distinct statements pass that bound, against **0** when they fit under it,
costing roughly 6 % on Chromium and 9 % on Firefox over a read-heavy loop. Generated SQL is
sometimes unavoidable — `IN (?, ?, ?)` changes shape with the list — and it still works; it
simply cannot be cached.

## *client*.write

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
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |

## *client*.stream

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
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

On `stream()`, `chunkSize` is the only lever on how many rows are in flight.

## *client*.chunk

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
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer. |

Here `chunkSize` is the batch size the consumer sees, not only a transport detail.

## *client*.first

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
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before it is aborted and rejected with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |

`first()` stops the query after one row instead of draining the result set.

## *client*.transaction

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
| `signal` | `AbortSignal` | — | Abandons the transaction. Rolls back and rejects with `signal.reason`; never commits. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before the transaction is abandoned. Rolls back and rejects with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |

## *client*.bulkWrite

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
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason`. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`. See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

## *client*.output

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
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason` and the target is untouched. See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds from the call before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`; the target is untouched. See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

**Inside a transaction, `output()` costs more than it looks.** On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

## *client*.inspect

```typescript
const { self, siblings, tabs, write } = await db.inspect();
```

Reports who is live on this client's database, in every tab of the origin. It is the same census as [`inspectDatabase`](#inspectdatabase), where the semantics and the caveats are documented — the difference is only the split: `db.inspect()` separates `self`, this client's own entry, from `siblings`, everyone else, where `inspectDatabase` returns one `clients` list.

`self` is `null` when this client's own marker is not in the snapshot.

After `close()` it throws `CLIENT_CLOSED`, like every other method on the client. [`inspectDatabase`](#inspectdatabase) answers the same question afterwards — `inspectDatabase(db.file, { vfs: db.vfs })`, which is what those two properties are for.

## *client*.close

```typescript
await db.close();
```

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers. The returned promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed. Calling `close()` a second time returns the same promise — the operation runs exactly once.

**`close()` is async.** Always `await db.close()`: discarding the returned promise means the caller cannot tell when teardown is complete.

**Stored data is not deleted.** `close()` releases workers and connections; it removes nothing. To remove the database itself, use [`deleteDatabase`](#deletedatabase).

**A page reload is not a close, and some engines make you wait for it.** Navigating away or
reloading discards the page without running `close()`, and the browser does not always release
the underlying connection at once — observed on iPadOS Safari 27, where the database stayed
held long enough for the next page's open to exhaust its full 30-second [`openTimeout`](#options)
and report `TIMEOUT`. If your application reloads while a client is open, close it first:
`window.addEventListener('pagehide', () => { void db.close(); })` is enough, and `pagehide`
fires where `unload` no longer does.

## deleteDatabase

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

## inspectDatabase

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

## Interrupting a call

`signal` and `timeout` both stop the *wait* immediately: `signal` rejects with `signal.reason`,
`timeout` rejects with `OPERATION_TIMEOUT`. Whether either also stops the *work* — the statement
SQLite is executing — depends on the build behind your VFS:

| build | your VFS | stops a running statement |
|---|---|---|
| `async`, `jspi` | `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `MemoryAsyncVFS` | yes |
| `sync` | `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`, `AccessHandlePoolVFS`, `MemoryVFS` | only if your page is cross-origin isolated |

`timeout` counts wall clock from the call, and your own time counts against it: the wait for a free
pool worker, the wait for another tab's write lock, and every pause you take yourself — between two
chunks of a `stream()`, inside a `transaction()` callback, between two `enqueue()` calls on a
`bulkWrite()`.

`timeout` aborts through the same path a `signal` does, so the same limit applies. Where it does
not stop the running statement, an aborted call keeps running to its end on its worker; the pool's
other workers are unaffected. Two ways out, and you may want neither: serve your page cross-origin
isolated — COOP+COEP anywhere, or `Document-Isolation-Policy` on Chromium — or pass
`build: 'async'`, which every one of those four VFS accepts.

The deadline is a browser timer, so a background tab that throttles `setTimeout` may fire it late.
`AbortSignal.timeout()` behaves identically — it is not a cost of the `timeout` option, but
documented because "wall clock from the call" invites the assumption that it is exact.

```typescript
// 5 s of wall clock. Rejects with OPERATION_TIMEOUT.
const rows = await db.read('SELECT * FROM large_table', [], { timeout: 5_000 });

// 5 s of wall clock. Rejects with the signal's reason (a DOMException TimeoutError).
const rows = await db.read('SELECT * FROM large_table', [], {
  signal: AbortSignal.timeout(5_000),
});
```

## Error handling

Errors raised by this library are instances of `SQLiteError`, exported from the package entry point. Discriminate on `error.code` or `error.name` — they carry the same value, so `err.name` reads the way `'AbortError'` does on a DOM `AbortError`.

| Code | When it is thrown |
|------|------------------|
| `NOT_A_READ_QUERY` | `read()`, `chunk()`, `stream()`, or `first()` was called with a statement that is not a provably readable query. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument must go through `write()`. |
| `CLIENT_CLOSED` | A query was queued after `close()` was called. |
| `WORKER_CRASHED` | A pool worker died and the supervisor decided not to restart it. All queued and in-flight work on that slot is rejected. |
| `TIMEOUT` | A worker did not post `ready` within `openTimeout` milliseconds. The most common cause is a database held under an exclusive lock by another tab or client. |
| `OPERATION_TIMEOUT` | The `timeout` set on a call was spent. The error carries it as `error.timeout`. Deliberately not `TIMEOUT`, which means a deadline this library imposed on itself — a worker that never became ready, a deletion that did not complete. |
| `PROTOCOL_ERROR` | A message was received from a worker that could not be deserialized (`messageerror`). The worker survives; only the in-flight request is rejected. |
| `BUSY` | A transient conflict, worth retrying. Either SQLite reported a lock conflict — `SQLITE_BUSY` or `SQLITE_LOCKED`, with the numeric code on `sqliteCode` — or a database was being opened or deleted elsewhere at that moment. **A read that SQLite reported busy is retried once for you**; if it reaches you, the retry failed too. Writes are never retried, and neither is a `BUSY` without a `sqliteCode`. |
| `INVALID_OPTION` | An option was refused at the call, before any worker ran: `vfs` missing or unknown, a `(vfs, build)` pair the VFS does not support, a `poolSize` above what the VFS allows, a `wasmUrl` that is not a URL, or `inspectDatabase` on a memory VFS. The message names the option and what it accepts. |
| `INVALID_PRAGMA` | A `pragmas` entry could not be rendered. The name must be a bare word; the value must be an integer, a bare word such as `WAL`, or a quoted SQL literal. |
| `INVALID_IDENTIFIER` | A name or type handed to `output()` or `bulkWrite()` cannot be used as written: an empty name, a name containing a NUL, a column type that is not a word with optional numeric arguments, or a generated expression that is not parenthesised and free of `;`. |
| `BULK_WRITE_FAILED` | A batch failed inside `bulkWrite().close()` or `output().close()`. The error is a `SQLiteBulkWriteError`, carrying `rowsWritten` and `rowsNotWritten`. |
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


**Read methods reject write statements.** `read()`, `chunk()`, `stream()`, and `first()` reject any statement that is not a provably readable query, throwing `NOT_A_READ_QUERY`. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument must go through `write()`.

