# API

Every method, property and option of [browser-sqlite](README.md).

[*client*.id](#clientid) · [*client*.name](#clientname) · [*client*.file](#clientfile) · [*client*.files](#clientfiles) · [*client*.vfs](#clientvfs) · [*client*.build](#clientbuild) · [*client*.poolSize](#clientpoolsize) · [*client*.ready](#clientready) · [*client*.debug](#clientdebug)

[createSQLiteClient()](#createsqliteclient) · [*client*.read()](#clientread) · [*client*.write()](#clientwrite) · [*client*.stream()](#clientstream) · [*client*.chunk()](#clientchunk) · [*client*.first()](#clientfirst) · [*client*.transaction()](#clienttransaction) · [*client*.bulkWrite()](#clientbulkwrite) · [*client*.output()](#clientoutput) · [*client*.inspect()](#clientinspect) · [*client*.close()](#clientclose) · [deleteDatabase()](#deletedatabase) · [inspectDatabase()](#inspectdatabase)

**[Queries](#queries)**: [Writing queries](#writing-queries) · [How they run](#how-they-run) · [Inside a transaction](#inside-a-transaction)

**[Interrupting a call](#interrupting-a-call)** · **[Error handling](#error-handling)** · **[Debugging](#debugging)**

## createSQLiteClient

`createSQLiteClient` spawns `poolSize` Web Worker threads immediately. Workers reach READY state asynchronously — queries made before workers are ready are queued automatically. [`ready`](#clientready) tells you when that startup is over.

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient(
  'myapp.sqlite',                   // database name — at most 52 characters once normalized
  {
    poolSize: 2,                    // number of worker threads (default: 2)
    vfs: 'OPFSAdaptiveVFS',         // required — see Browser compatibility
    build: 'async',                 // wa-sqlite build (default: the first the browser supports)
    pragmas: {                      // SQLite PRAGMAs (see the table below)
      journal_mode: 'WAL',
      synchronous: 'NORMAL',
    },
  },
);
```

`vfs` is the only option with no default — see our [recommendations](VFS.md#recommendations) and the [full VFS documentation](VFS.md) to choose your own.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2` | Web Workers in the pool. [More info](#poolsize) |
| `vfs` | `SQLiteVFS` | — (required) | Where the database is stored.<br>See [Recommendations](VFS.md#recommendations). |
| `build` | `SQLiteBuild` | first build the VFS declares that the browser supports | Which wa-sqlite WebAssembly build to load. [More info](#build) |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Where the workers fetch their `.wasm`. [More info](#wasmurl) |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs, merged over the VFS's defaults. [More info](#pragmas) |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. [More info](#maxworkerrestarts) |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to report ready after `open` is sent. [More info](#opentimeout) |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run before the worker is presumed dead. |
| `debug` | `string \| boolean` | `undefined` | Lifecycle logging, and the [`db.debug`](#clientdebug) introspection tree. [More info](#debug) |
| `onWorkerLost` | `(event: WorkerLostEvent) => void` | `undefined` | Called when a worker is lost for good. [More info](#onworkerlost) |

#### `poolSize`

The VFS and the environment cap it. A VFS with a pool limit throws if you pass more; omitting `poolSize` never throws. Where the engine lacks `readwrite-unsafe`, a VFS that needs it for a second worker runs one, without an error, and warns once if you passed `poolSize`. [`poolSize`](#clientpoolsize) tells you the size you got; each VFS's limit is in the [VFS reference](VFS.md#vfs-reference).

#### `build`

Throws `INVALID_OPTION` at construction when the VFS does not declare that build, naming the ones it does. Which builds each browser runs: [Builds reference](VFS.md#builds-reference).

#### `wasmUrl`

Read once, at construction, and throws `INVALID_OPTION` there if the value is not a URL. A string is a directory resolved against the page — relative, absolute or a full URL, trailing slash optional. A callback receives the resolved `build` and names one file, for a bundler-emitted asset carrying a content hash. Serving from another origin needs CORS and `Content-Type: application/wasm`.

#### `pragmas`

Those that configure a connection are applied on every worker as it opens. Those that write the database — `user_version`, `application_id`, `schema_version`, `auto_vacuum`, `incremental_vacuum`, `optimize`, `wal_checkpoint` — are applied once, as a write, before the client's first query.

A VFS may set defaults of its own and refuse a pragma — see its entry in the [VFS reference](VFS.md#vfs-reference). A refused pragma fails with `INVALID_PRAGMA`, in `pragmas` and in any statement that sets it.

#### `maxWorkerRestarts`

Counts from the last replacement that actually served a request. A slot that fails to *open* is retried once, and only if another worker did open — when none did, the failure is a configuration error and the client fails immediately.

#### `openTimeout`

Most often expires on a database another tab holds under an exclusive lock. **A pool that will never open takes up to twice this before your first query rejects**, because a failed slot is retried once when another slot opens; at the default that is about a minute with nothing reported.

#### `debug`

Logs lifecycle events only — worker created, ready, open-error, crash, restart, worker lost, close, skipped staging sweep — never one line per query. A string is used as the log prefix, `true` falls back to the client name. One thing is logged even when it is off: a permanently lost worker always warns, with the error that killed it, because a pool quietly smaller than `poolSize` is not something to discover later.

#### `onWorkerLost`

Receives the slot index, how many workers are left, the pool's size — [`poolSize`](#clientpoolsize), not the option — and the error. It fires before the client fails if that worker was the last. A callback that throws is caught and warned about; it cannot break the pool. A worker the environment never let open is not lost: nothing is reported for it.

## *client*.id

`string`, readonly. A UUID minted for this client, unique across the origin. It is what tells two clients apart in [`inspectDatabase`](#inspectdatabase)'s roster.

## *client*.name

`string`, readonly. The `name` option followed by this client's index in its tab — `"SQLite 1"` by default. It is the same string the `debug` logger prefixes its lines with. Two tabs can produce the same one; `id` is what cannot collide.

## *client*.file

`string`, readonly. The database name you passed, normalized — what to hand back to [`inspectDatabase`](#inspectdatabase) and [`deleteDatabase`](#deletedatabase). It may differ from what you passed.

A database name may be 52 characters once normalized, where a non-ASCII character counts three per UTF-8 byte. It must also not be empty once normalized.

## *client*.files

`readonly string[]`. Every name this database's files may have, as the VFS receives them: the database, `-journal`, `-wal`, and the VFS's own extra files. On a VFS with a folder these are OPFS paths; elsewhere they are names inside the VFS's own store. Empty on the memory VFS.

## *client*.vfs

`SQLiteVFS`, readonly. The VFS this client opened with.

## *client*.build

`SQLiteBuild`, readonly. The wa-sqlite build actually loaded — the first build the VFS declares that the browser supports, when `build` was not passed.

## *client*.poolSize

`number`, readonly. The number of workers the pool runs: `poolSize` as requested, capped by the VFS and by the environment. Exact once [`ready`](#clientready) resolves — and every query waits for that, so it is settled by the time any query returns.

## *client*.ready

`Promise<void>`, readonly. Settles once the pool has started: every worker has opened, been declined by the environment, or failed its one retry. It resolves when at least one worker serves the database, and the [pragmas](#pragmas) that write the database are applied; [`poolSize`](#clientpoolsize) is final from then on. It rejects with the error that failed the client — `WORKER_CRASHED` when no worker could open, `DATABASE_IN_USE` when another client holds the database exclusively, `STATEMENT_FAILED` when SQLite refused one of those pragmas — and with `CLIENT_CLOSED` when `close()` comes first.

You never need to await it: queries wait for the pool on their own. It settles once — a worker lost later is reported by [`onWorkerLost`](#onworkerlost), not here — and leaving it unread never raises an unhandled rejection.

## *client*.read

Sends a read query and returns the full result.

```typescript
type User = { id: number; name: string };

const users = await db.read<User>(
  'SELECT id, name FROM users WHERE active = ?',
  [1],
);
// users: User[]
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk<sup><a href="#fn-1">[1]</a></sup>. |

On `read()` this is transport only — it still resolves with the whole array.

See [Writing queries](#writing-queries).

## *client*.write

Sends a write query and resolves with `affected`, how many rows it changed — 0 for a statement that changes nothing — and `result`, the rows it returned.

```typescript
const { affected } = await db.write(
  'INSERT INTO users (name, email) VALUES (?, ?)',
  ['Alice', 'alice@example.com'],
);
// affected: number of rows inserted

const { result } = await db.write<{ id: number }>(
  'INSERT INTO users (name) VALUES (?) RETURNING id',
  ['Bob'],
);
// result: { id: number }[]
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |

**`result` is how to read a `RETURNING` clause outside a transaction.**<br>It holds every row the statement returns, gathered before the call resolves. `read()`, `first()`, `chunk()` and `stream()` refuse a write; inside a [transaction](#clienttransaction), `tx.first()`, `tx.chunk()` and `tx.stream()` accept one, to take its rows one at a time or in chunks.

**Transaction control is refused.**<br>`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` reject with `STATEMENT_FAILED` and `sqliteCode` `23` (`SQLITE_CODES.AUTH`), on the client and inside a transaction alike. On the client, each call may run on a different connection, so a transaction opened this way could never be closed; inside a transaction, the library owns the transaction and its savepoints. Use [`transaction()`](#clienttransaction), and `tx.savepoint()` inside it. In a string of several statements, the ones before the refused statement have run — outside a transaction, they are committed.

See [Writing queries](#writing-queries).

## *client*.stream

Yields individual rows without buffering the full result set in memory. Use [`chunk()`](#clientchunk) to iterate in batches instead.

```typescript
for await (const row of db.stream<User>('SELECT * FROM large_table', [])) {
  processRow(row); // row is User
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk<sup><a href="#fn-1">[1]</a></sup>. |

On `stream()`, `chunkSize` is the only lever on how many rows are in flight.

See [Writing queries](#writing-queries).

## *client*.chunk

Yields arrays of rows instead of rows one by one.

```typescript
for await (const rows of db.chunk<User>('SELECT * FROM large_table', [])) {
  processBatch(rows); // rows is User[]
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |
| `chunkSize` | `number` | `500` | Rows per chunk<sup><a href="#fn-1">[1]</a></sup>. |

Here `chunkSize` is the batch size the consumer sees, not only a transport detail.

See [Writing queries](#writing-queries).

## *client*.first

`first()` returns the first result row, or `undefined` if no rows match. Use it for lookups by primary key or unique field.

```typescript
const user = await db.first<User>(
  'SELECT * FROM users WHERE id = ?',
  [42],
);
// user: User | undefined
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |

`first()` stops the query after one row instead of draining the result set.

See [Writing queries](#writing-queries).

## *client*.transaction

Runs a callback inside a transaction. Returning commits, throwing rolls back and re-throws.

```typescript
const orders = await db.transaction(async (tx) => {
  await tx.write('INSERT INTO orders (id, total) VALUES (?, ?)', [1, 42]);
  await tx.write('UPDATE stock SET qty = qty - 1 WHERE id = ?', [7]);
  const rows = await tx.read<{ n: number }>('SELECT count(*) AS n FROM orders');
  return rows[0].n;
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `readOnly` | `boolean` | `false` | Rejects write statements with `READ_ONLY_TRANSACTION`, at the call rather than at the first flush. |
| `autoCommit` | `boolean` | `true` | Commits when the callback resolves. Set it false to call `commit()` or `rollback()` yourself. |
| `signal` | `AbortSignal` | — | Abandons the transaction. Rolls back and rejects with `signal.reason`; never commits.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before the transaction is abandoned. Rolls back and rejects with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |

**One worker serves the whole callback.**<br>This way, the transaction is genuinely isolated rather than merely wrapped in `BEGIN`. `tx` carries the same querying surface as the client — `read`, `write`, `chunk`, `stream`, `first`, `bulkWrite`, `output` — plus `commit`, `rollback`, `savepoint` and `signal`. `signal` aborts whenever `transaction()` rejects; see [Inside a transaction](#inside-a-transaction).

**`tx.savepoint(name?)` opens a block you can undo without abandoning the transaction.**<br>It resolves to a handle with `name`, `release()` and `rollback({ release = true })`:

```typescript
await db.transaction(async (tx) => {
  for (const order of orders) {
    const sp = await tx.savepoint();
    try {
      await tx.write('INSERT INTO orders (id, total) VALUES (?, ?)', [order.id, order.total]);
      await tx.write('UPDATE stock SET qty = qty - 1 WHERE id = ?', [order.item]);
      await sp.release();
    } catch {
      await sp.rollback(); // this order only
    }
  }
});
```

- `rollback()` undoes everything written since the savepoint and closes it; `rollback({ release: false })` undoes it and keeps the savepoint open, to roll back to again. `release()` keeps what was written and closes it — nothing is durable before the transaction commits.
- Savepoints nest in the order they are opened. Releasing or rolling back one closes every savepoint opened after it; a method on a closed handle resolves when what it promises is already true and rejects with `SAVEPOINT_CLOSED` otherwise.
- `name` is optional; one is generated otherwise (`__bsq_sp_1`, `__bsq_sp_2`…). A name already open, empty, or starting with `__bsq_` is refused with `INVALID_IDENTIFIER`.
- A savepoint still open when the transaction commits is committed with it. Once the transaction is over, the handle rejects with `TRANSACTION_CLOSED`.
- `tx.savepoint()`, `release()` and `rollback()` take no `signal`, like `commit()` and `rollback()`. A read-only transaction refuses `tx.savepoint()` with `READ_ONLY_TRANSACTION`.
- Close every savepoint you open in a loop: an open savepoint makes every later write in the transaction slower, and thousands of them add up.

> [!WARNING]
> **A write transaction holds the only writing slot in the origin for as long as its callback runs.**<br>Writes are serialized across every client and every tab, so a callback that waits on something slow makes every other writer in the origin wait with it — not only the ones on this client. Keep the callback to the statements it needs.

See [Queries: Inside a transaction](#inside-a-transaction).

## *client*.bulkWrite

Returns an `enqueue()` / `close()` pair that batches rows into multi-row inserts.

```typescript
const rows = db.bulkWrite(
  'events',              // the table to insert into
  ['id', 'kind', 'at'],  // the columns to fill
);
for (const event of events) {
  await rows.enqueue(event); // one object per row; only those keys are read
}
const written = await rows.close(); // rows written, in total
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |
| `types` | `{ [column]: 'JSONB' }` | — | Columns stored as JSONB. [More info](#how-values-are-stored) |

**Single-use.**<br>`enqueue()` and `close()` throw once closed. A batch is flushed whenever the next row would cross SQLite's variable limit; `close()` flushes what is left and resolves with the total.

**Batches are committed as they flush, so a load is never all-or-nothing.**<br>A failure and an abort both stop it and leave the rows already written in place — for all or nothing, use a [transaction](#clienttransaction). Neither can tear a batch: a multi-row `INSERT` is statement-atomic, so a failing batch wrote nothing and an abort lands between batches. A failure rejects `close()` with a `SQLiteBulkWriteError` carrying `rowsWritten` and `rowsNotWritten`.

**Always call `close()`, including after `enqueue()` has thrown.**<br>It is the only path that detaches the abort listener from your `signal` and clears the `timeout` timer, and it is where the outcome is reported: `signal.reason` when the load was aborted, a `SQLiteBulkWriteError` carrying the counts when a batch failed. Rows already flushed are written either way — skipping `close()` leaks the listener and the timer, and tells you nothing about what landed.

**Await `enqueue()` to be slowed to the speed of the database.**<br>It resolves immediately while fewer than `queueSize` rows are queued for writing, and only defers beyond that — so a producer that awaits every row never holds more than that many unwritten rows. Ignoring the returned promise is legal and loads exactly as before: the bound is an offer, not a guarantee, and only you can take it. `queueSize` counts rows, not bytes: if your columns carry blobs, set it yourself.

#### How values are stored

| Value | Column | `JSONB` column |
|---|---|---|
| string | as given | JSON string |
| number, bigint, `null` | as given | as given |
| boolean | `1` / `0` | `true` / `false` |
| `Uint8Array` | BLOB | read as JSONB already encoded |
| `Date` | `YYYY-MM-DD HH:MM:SS.SSS`, UTC | JSON string, `"YYYY-MM-DDTHH:MM:SS.SSSZ"` |
| any other object, arrays included | `JSON.stringify` text | `JSON.stringify` |

**Objects follow `JSON.stringify`'s rules, at every depth.**<br>A `Map` or a `Set` gives `{}`, a class instance its own properties or its `toJSON()`, and a nested `Date` its ISO string. A value it refuses — a nested `bigint`, a cycle — makes `enqueue()` throw, and that row is not queued.

**An array is stored as JSON.**<br>Pass a `Uint8Array` to store bytes.

**A `Date` is stored in SQLite's own format, so it compares as text with SQLite's dates.**<br>`datetime('now', 'subsec')` gives the same shape. `CURRENT_TIMESTAMP` has no milliseconds: `'2026-10-06 12:34:56.000'` sorts after `'2026-10-06 12:34:56'`, the same instant.

**A `JSONB` column stores every value as JSON.**<br>Declare it with `types: { doc: 'JSONB' }`; each value is stored through `jsonb()` as JSON, a string as a JSON string. A `Uint8Array` is taken as JSONB already encoded, and one that is not valid JSONB fails its batch. A plain `SELECT` returns the column as bytes (a `Uint8Array`); `json(col)` returns it as JSON text.


## *client*.output

Builds a table from a schema declaration and fills it through the same `enqueue()` / `close()` pair as [`bulkWrite()`](#clientbulkwrite).

```typescript
const out = db.output(
  'products',
  { id: 'INTEGER', name: 'TEXT', price: { type: 'REAL', required: true } },
  { indexes: ['name', { columns: ['name', 'price'], unique: true }] },
);
await out.enqueue({ id: 1, name: 'widget', price: 9.99 });
const written = await out.close();
```

| Option | Type | Default | Description |
|---|---|---|---|
| `indexes` | `Index[]` | — | Indexes built after the swap, under their final names. A column name, an array of them, or `{ columns, unique }`. |
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason` and the target is untouched.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`; the target is untouched.<br>See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

**Values are stored as in [`bulkWrite()`](#how-values-are-stored).**<br>A column whose type is `JSONB` is a JSONB column; no option is needed.

**The target is replaced atomically, or not at all.**<br>Rows land in a staging table and the swap happens at `close()`, so a reader querying mid-load sees the old data, never a half-filled table — and a target that did not exist appears only at `close()`. An abort is observationally a no-op: the staging table is dropped, nothing else is touched, and whatever was in the target before is still there, whole.

**Always call `close()`, as on [`bulkWrite()`](#clientbulkwrite).**<br>Here it also drops the staging table and releases the lock the load holds, on the failing path as much as on the succeeding one. It is single-use, like `bulkWrite()`.

**Inside a transaction, `output()` costs more than it looks.**<br>On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

## *client*.inspect

Reports who is live on this client's database, in every tab of the origin.

```typescript
const { self, siblings, tabs, write } = await db.inspect();
```

It is the same census as [`inspectDatabase`](#inspectdatabase), where the semantics and the caveats are documented. The difference is only the split: `db.inspect()` separates `self`, this client's own entry, from `siblings`, everyone else, where `inspectDatabase` returns one `clients` list. `self` is `null` when this client's own marker is not in the snapshot.

After the client's own [`close()`](#clientclose) it throws `CLIENT_CLOSED`, like every other method on it. [`inspectDatabase`](#inspectdatabase) answers the same question afterwards — `inspectDatabase(db.file, { vfs: db.vfs })`, which is what `db.file` and `db.vfs` are for.

## *client*.debug

`ClientDebugState | undefined`, readonly. The pool as it is right now, when the [`debug`](#debug) option is set; `undefined` otherwise. **Its shape is outside semver: any release may change it.**

See [Debugging](#debugging).

## *client*.close

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers.

```typescript
await db.close();
```

**`close()` is async.**<br>Always `await db.close()`: the promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed, and discarding it means the caller cannot tell when teardown is complete. Calling it a second time returns the same promise — the operation runs exactly once.

**Stored data is not deleted.**<br>`close()` releases workers and connections; it removes nothing. To remove the database itself, use [`deleteDatabase`](#deletedatabase).

**A page reload is not a close, and some engines make you wait for it.**<br>Navigating away or reloading discards the page without running `close()`, and the browser does not always release the underlying connection at once — the next page's open can then exhaust its [`openTimeout`](#opentimeout) and report `TIMEOUT`.<br> **If your application reloads** while a client is open, close it first:

```typescript
window.addEventListener('pagehide', () => {
  void db.close();
});
```

`pagehide` fires where `unload` no longer does.

## deleteDatabase

Removes a database and every file kept beside it — the `-journal` / `-wal` files SQLite may leave, and any the VFS keeps of its own (see its entry in the [VFS reference](VFS.md#vfs-reference)).

```typescript
import { deleteDatabase } from 'browser-sqlite';

await deleteDatabase('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. |
| `build` | `SQLiteBuild` | first build the VFS declares that the browser supports | Which wa-sqlite build to load. It does not affect where the database lives — only which builds can instantiate the VFS. |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Same meaning as on [`createSQLiteClient`](#wasmurl). A deployment that needs it to open a database needs it to delete one. |

Deleting a database that is not there throws — most often because `vfs` is not the one it was created with.

What a VFS keeps for itself is left alone — an IndexedDB store it shares between its databases, or a pool of files it keeps as reusable capacity. The deleted database's own bytes are freed in both cases.

**The database must not be open, in this tab or any other.**<br>`DATABASE_IN_USE` says a client still holds it, and retrying will not help — closing every client on it is what releases it. A client your application stopped using but never closed keeps blocking until its tab goes, and this library cannot revoke a connection it did not open: another library or native code on the same origin is invisible to it.

The other codes: `DATABASE_NOT_FOUND` means there was nothing at that name. `BUSY` is the transient case — another open or another delete was in flight at that moment, and retrying is the remedy. `TIMEOUT` means the VFS could not answer within 30 seconds.


## inspectDatabase

Reports who is live on a database, in every tab of the origin, **without opening it**.

```typescript
import { inspectDatabase } from 'browser-sqlite';

const { clients, tabs, write } = await inspectDatabase('myapp.sqlite', {
  vfs: 'OPFSAdaptiveVFS',
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. |

It answers from code that holds no client — opening one to learn who holds the database would defeat the question.

| Field | Type | Description |
|---|---|---|
| `file` | `string` | The database file, normalized — the same value as `db.file`. |
| `vfs` | `SQLiteVFS` | The VFS the report was taken through. |
| `clients[].id` | `string` | The client's UUID, matching its own `db.id`. |
| `clients[].name` | `string` | The client's label with its index, e.g. `"SQLite 1"`. Not unique across tabs. |
| `clients[].tab` | `string` | The tab holding it. Every client in one tab reports the same value. |
| `clients[].sameTab` | `boolean` | That tab is the caller's. |
| `clients[].vfs` | `SQLiteVFS` | Which VFS it opened with. |
| `tabs` | `number` | Distinct tabs among `clients`. Not the same as `clients.length`. |
| `write.tab` | `string \| null` | The tab holding the write lock right now, or `null`. A tab, never a client: the lock's name is the mutex and carries no client identity. |
| `write.sameTab` | `boolean` | Always `false` when `write.tab` is `null`. |
| `write.waiting` | `number` | Writers queued behind it, across the whole origin. |

**"Tab" means realm.**<br>A same-origin iframe in your own page is a different tab here: it has its own identity, so `sameTab` is `false` for it.

**A snapshot, never a permission.**<br>It is stale the instant it resolves. An empty roster does not mean a database can be deleted — a tab may open between the two calls, and [`deleteDatabase`](#deletedatabase) raising `DATABASE_IN_USE` remains the only authority. An empty roster also does not distinguish a database nobody holds from one that does not exist; `DATABASE_NOT_FOUND` is what says that.

**Polling is on the call.**<br>Nothing is kept between two calls, and there is no event to subscribe to. A call makes no worker round trip, and the tab's identity is resolved and cached once, so subsequent calls take no lock — polling cannot slow a query down. Do not stack calls: a background tab has its timers throttled, and an interval that fires without awaiting the previous answer will queue them up.

A memory VFS throws `INVALID_OPTION`: its pages live in the worker that opened them, so two clients are two databases and there is nothing to share. Where the Web Locks API is missing, `inspectDatabase` and `db.inspect()` throw `UNSUPPORTED` rather than report zero.

## Queries

### Writing queries

**Pass values as `?` parameters rather than building them into the SQL.**<br>Each worker keeps a cache of 32 prepared statements, keyed on the exact SQL string. Interpolating a value makes every call a new key, so nothing is ever reused and every query is recompiled. Generated SQL is sometimes unavoidable — `IN (?, ?, ?)` changes shape with the list — and it still works; it simply cannot be cached.

### How they run

Read queries are dispatched to any available worker, so several run at once.

Write queries are serialized per database across the whole origin — one at a time, across every client and every tab, not only within the client that issued them.

**A generator holds its worker for its whole lifetime.**<br>[`stream()`](#clientstream) and [`chunk()`](#clientchunk) keep the worker that serves them until the loop ends, so always exhaust the generator, `break` out of it, or call its `return()` — `await using` does the same where your engine has the syntax. One you simply drop is recovered only when the engine collects it, which is no schedule to rely on; a `timeout` or a `signal` is what gives it a deadline. Prefer `chunk()` where the work is per-batch — one `INSERT` per chunk rather than per row.

### Inside a transaction

When using [*client*.transaction()](#clienttransaction), the rules below apply to the callback and to every statement it issues.

**Rows land only on a `COMMIT` that succeeds.**<br>Everything else rolls back: a callback that throws, an abort, a `COMMIT` that fails, and — under `autoCommit: false` — a callback that returns without calling `tx.commit()`. Catching a rejection caused by the transaction's own `signal` or `timeout` does not let you commit around it. The one exception is an explicit `tx.commit()` that has already succeeded: an abort landing after it still ends the call, but the commit itself stands — nothing is undone. If the rollback itself fails the worker is evicted, rather than returned to the pool holding an open transaction.

**An abort reaches further than a statement.**<br>`signal` and `timeout` abandon the transaction at any point. The callback is not interrupted — it runs on — but every statement it issues afterwards rejects with `TRANSACTION_CLOSED`. `BEGIN`, `COMMIT` and `ROLLBACK` are the exception: they carry no signal, so they complete regardless — an abort raised while an explicit `commit()` is in flight still rejects `transaction()`, although the commit itself stands.

**A statement abandoned by its own `signal` or `timeout` has no effect, and the transaction goes on.**<br>A statement's own `signal` or `timeout` rejects that statement at once, with its own reason, and whatever it was — a read, a write, a `bulkWrite()` batch — it leaves nothing behind. Caught, your callback continues: what it wrote before still stands, and a later commit keeps it; an abandoned `bulkWrite()` keeps the batches it had completed. A write that was already running when the abort landed runs on to its end and is then undone, so the next statement you issue — or the commit — waits for it, with the write lock held; that statement's own `signal` or `timeout` bounds the wait, and so do the transaction's own. Let the rejection escape the callback instead and the whole transaction is abandoned: `transaction()` rejects with that reason and nothing the transaction wrote is kept.

**A transaction object is closed once its transaction is over.**<br>Whether it committed, rolled back or was abandoned, any statement issued on it afterwards rejects — or, for `bulkWrite()` and `output()`, throws — with `TRANSACTION_CLOSED` without reaching the database; its `cause` is the reason the transaction was abandoned, and is absent after a commit or a rollback. `commit()` resolves if the transaction committed and rejects otherwise. `rollback()` always resolves, and warns in the console when the transaction had already committed.

**`tx.signal` stops your own work with the transaction.**<br>It aborts whenever `transaction()` rejects, with the value it rejects with, and never when it resolves. Hand it to anything the callback awaits that is not a statement:

```typescript
await db.transaction(async (tx) => {
  const rows = await tx.read('SELECT …');
  const priced = await fetch(url, { signal: tx.signal });
  await tx.write('INSERT …', [priced]);
});
```

**[`close()`](#clientclose) abandons the transaction the same way.**<br>It rejects with `CLIENT_CLOSED`, the callback runs on but can no longer reach the database, and the origin's write lock the transaction was holding is given back — otherwise a callback waiting on something that never arrives keeps every other writer in the origin waiting with it, in this tab and in others. **Attach a handler to a transaction you do not await**, or closing while one runs surfaces an unhandled rejection.

**A statement in flight inside a transaction is abandoned; one outside is not.**<br>`close()` drains an ordinary write, because each is its own commit and rejecting it would report failure for a row that landed. Nothing inside a transaction is durable until its `COMMIT`, so there is nothing to misreport.

**A statement waits for the connection before it resolves.**<br>Every statement in a transaction runs on the same connection, and one that ends early leaves it finishing behind: [`first()`](#clientfirst) stops at the first row, a [`chunk()`](#clientchunk) or [`stream()`](#clientstream) you `break` out of stops mid-result, an abort cuts a statement short. Each one waits for the connection to be free, so the next statement in the same callback runs normally. Any generator the callback leaves open is closed before the transaction commits or rolls back.

**Statements share one connection and run one at a time, in the order you issue them.**<br>Creating several without awaiting each in turn is fine — `await Promise.all([tx.read(…), tx.read(…)])` runs them back to back, in the order you called them, not the order they resolve. `commit()` takes its place in that queue like any other statement, and so does each batch a `bulkWrite()` flushes. A statement aborted by its own `signal` or `timeout` while it is still waiting its turn never reaches the database and rejects alone; the ones behind it keep their order.

**Savepoints follow the same order.**<br>They form a stack in the order `tx.savepoint()`, `release()` and `rollback()` are called, not in the shape of your code. Two async branches that open savepoints in the same transaction undo each other's writes: a branch rolling back its savepoint also undoes what the other branch wrote after that savepoint opened. A `bulkWrite()` still open when its savepoint closes sends its later batches to the enclosing scope, and an `output()` must be closed before the savepoint that contains it ends — its staging table is created asynchronously, so a rollback issued while it is open may or may not undo it. Close a load before you end its savepoint.

**A generator you have stopped pulling holds the connection, and everything issued after it waits.**<br>That is the one case where waiting does not end on its own: the library cannot tell a generator you have abandoned from one whose loop body is merely slow, so it does not decide for you — it warns on the console after a few seconds and keeps waiting. Close your generators, and give a `timeout` to the statements that follow one if a consumer might not.

**A generator you simply drop is the exception.**<br>Closing one is what the transaction can wait for — exhaust it, `break` out of it, call its `return()`, or use `await using`. One that is neither closed nor exhausted still holds the connection, so the next statement in the same callback waits for it — including an explicit `tx.commit()`.

> [!WARNING]
> On the `sync` build without cross-origin isolation, a statement already running cannot be stopped — see [Interrupting a call](#interrupting-a-call). Waiting for it is then the whole of what a statement ending early costs: `first()`, a `break`, or the end of the callback waits for the statement to finish on its own, up to `drainTimeout`, 60 s by default, with the write lock still held. On every other build the statement is stopped and the wait is negligible.

See [Queries: How they run](#how-they-run).

## Interrupting a call

`signal` and `timeout` both stop the *wait* immediately: `signal` rejects with `signal.reason`, `timeout` rejects with `OPERATION_TIMEOUT`.

```typescript
// Rejects with OPERATION_TIMEOUT.
const rows = await db.read('SELECT * FROM large_table', [], { timeout: 5_000 });

// Rejects with the signal's reason (a DOMException TimeoutError).
const rows = await db.read('SELECT * FROM large_table', [], {
  signal: AbortSignal.timeout(5_000),
});
```

> [!IMPORTANT]
> Whether either also stops the statement execution depends on the build you are running, not on the VFS:
>
> - `async` and `jspi` interrupt it everywhere
> - `sync` only when your page is cross-origin isolated
>
> Which builds a VFS offers, and which one it defaults to, are in the [VFS reference](VFS.md#vfs-reference).

**Leaving a call early stops its statement the same way, with no `signal` needed.**<br>That is a [`first()`](#clientfirst) once it has its row, or a [`stream()`](#clientstream) or [`chunk()`](#clientchunk) you `break` out of or `return()` from. Where the abort reaches the statement, the worker is free for your next call at once; elsewhere that call waits for the statement to end.

**`timeout` counts wall clock from the call, and your own time counts against it.**<br>That includes the wait for a free pool worker, the wait for another tab's write lock, and every pause you take yourself — between two chunks of a `stream()`, inside a `transaction()` callback, between two `enqueue()` calls on a `bulkWrite()`. It aborts through the same path a `signal` does, so the same limit applies, and it is a browser timer: a background tab that throttles `setTimeout` may fire it late. `AbortSignal.timeout()` behaves identically.

Where the abort does not reach the statement, the call rejects but the statement runs to its end on its worker, which stays unavailable until it does. The pool's other workers are unaffected. There are ways out, and you may want neither.

Serving the page **cross-origin isolated** is the first. Either header set below does it, and each costs something:

- **`Cross-Origin-Opener-Policy: same-origin` together with `Cross-Origin-Embedder-Policy: require-corp`** — works in every engine. Every cross-origin subresource must then opt in through `Cross-Origin-Resource-Policy` or CORS, so third-party images, fonts, scripts and iframes stop loading unless they cooperate; and `same-origin` severs the opener link with cross-origin popups, which breaks sign-in and payment windows that depend on it.
- **`Document-Isolation-Policy: isolate-and-require-corp`** — Chromium only; Firefox ignores it, so it cannot be your only measure on a cross-browser deployment. Cross-origin subresources still need `Cross-Origin-Resource-Policy`, but no `Cross-Origin-Opener-Policy` is involved, so popups and opener relationships keep working and the isolation applies to this document rather than to everything around it.

The second is a build other than `sync`: `jspi` where the browser has it, otherwise `async`, which is slower wherever a query walks rows.

## Error handling

Errors raised by this library, and every statement SQLite refuses, are instances of `SQLiteError`, exported from the package entry point.

| Code | When it is thrown |
|------|------------------|
| `NOT_A_READ_QUERY` | `read()`, `chunk()`, `stream()`, or `first()` was called with a statement that is not a provably readable query. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument, and `PRAGMA optimize`, `incremental_vacuum` and `wal_checkpoint`, which write, must go through `write()`. |
| `CLIENT_CLOSED` | A query was queued after `close()` was called. |
| `WORKER_CRASHED` | A pool worker died and the supervisor decided not to restart it. All queued and in-flight work on that slot is rejected. When SQLite refused to open the database — a file that is not a database, a `pragmas` entry it rejected — `sqliteCode` carries its result code. |
| `TIMEOUT` | A worker did not post `ready` within `openTimeout` milliseconds. The most common cause is a database held under an exclusive lock by another tab or client. |
| `OPERATION_TIMEOUT` | The `timeout` set on a call was spent. The error carries it as `error.timeout`. Deliberately not `TIMEOUT`, which means a deadline this library imposed on itself — a worker that never became ready, a deletion that did not complete. |
| `PROTOCOL_ERROR` | A message was received from a worker that could not be deserialized (`messageerror`). The worker survives; only the in-flight request is rejected. |
| `STATEMENT_FAILED` | SQLite refused or failed a statement for any reason other than a lock conflict: a constraint, a syntax error, a full disk, a file that is not a database. `message` is SQLite's own; `sqliteCode` carries its result code, and `sqliteExtendedCode` its subtype when SQLite reports one. Transaction control sent as SQL is refused with `sqliteCode` `23` (`SQLITE_AUTH`); see [*client*.write](#clientwrite). |
| `BUSY` | A transient conflict, worth retrying. Either SQLite reported a lock conflict — `SQLITE_BUSY` or `SQLITE_LOCKED`, with its result code on `sqliteCode` and, when SQLite reports one, its subtype on `sqliteExtendedCode` — or a database was being opened or deleted elsewhere at that moment. **A read that SQLite reported busy is retried once for you**; if it reaches you, the retry failed too. Writes are never retried, and neither is a `BUSY` without a `sqliteCode`. |
| `INVALID_OPTION` | An option was refused at the call, before any worker ran: `vfs` missing or unknown, a `(vfs, build)` pair the VFS does not support, a `poolSize` above what the VFS allows, a `wasmUrl` that is not a URL, a database name too long once normalized, a database name that is empty once normalized, a `bulkWrite()` `types` naming a column it does not write or a type other than `'JSONB'`, or `inspectDatabase` on a memory VFS. The message names the option and what it accepts. |
| `INVALID_PRAGMA` | A `pragmas` entry could not be rendered — the name must be a bare word; the value must be an integer, a bare word such as `WAL`, or a quoted SQL literal — or the VFS refuses it, in `pragmas` or in a statement that sets it ([VFS.md](VFS.md)). |
| `INVALID_IDENTIFIER` | A name or type handed to `output()`, `bulkWrite()` or `tx.savepoint()` cannot be used as written: an empty name, a name containing a NUL, a column type that is not a word with optional numeric arguments, or a generated expression that is not parenthesised and free of `;`. For `tx.savepoint()`: a name starting with `__bsq_`, or one already open. |
| `BULK_WRITE_FAILED` | A batch failed inside `bulkWrite().close()` or `output().close()`. The error is a `SQLiteBulkWriteError`, carrying `rowsWritten` and `rowsNotWritten`. |
| `DATABASE_IN_USE` | A client still holds the database, in this tab or another. Retrying will not help: close every client on it first. Raised by `deleteDatabase`, and by any method on a second client where the VFS supports one connection at a time. |
| `DATABASE_NOT_FOUND` | There is nothing at that name to delete. Raised by `deleteDatabase` alone — `createSQLiteClient` creates a database that is absent, so it has no such case. The likeliest cause is a `vfs` that is not the one the database was created with. |
| `UNSUPPORTED` | The platform cannot answer. Raised by `inspectDatabase` and `db.inspect()` where the Web Locks API is unavailable — reporting zero clients there would be indistinguishable from a database nobody holds. |
| `WORKER_BUSY` | A statement reached a worker that still had a query in flight. You should never see it: a statement holds its worker until it is idle, and a transaction queues its statements. If you do, that serialisation was broken — please report it. |
| `READ_ONLY_TRANSACTION` | raised when a write statement, `bulkWrite()`, `output()` or `tx.savepoint()` is used inside a transaction opened with `readOnly: true`. |
| `TRANSACTION_CLOSED` | A statement, `commit()`, `bulkWrite()`, `output()`, `tx.savepoint()` or a savepoint handle's `release()` or `rollback()` was used on a transaction object whose transaction is over. `error.cause` is the reason the transaction was abandoned; it is absent when the transaction committed or rolled back. |
| `SAVEPOINT_CLOSED` | `release()` on a savepoint already rolled back, `rollback()` on one already released, or `rollback({ release: false })` on one already rolled back and closed (it promises an open savepoint) — by itself or along with a savepoint it was nested in. `error.cause` is `{ by, savepoint }`: the operation that closed it and the savepoint it addressed. |

Discriminate on `error.code` or `error.name` — they carry the same value, so `err.name` reads the way `'AbortError'` does on a DOM `AbortError`.

**SQLite's result codes.**<br>An error SQLite reported carries its result code on `sqliteCode` and, when a statement failed with a subtype, that subtype on `sqliteExtendedCode`: a UNIQUE violation gives `19` and `2067`, a foreign key `19` and `787`, a full disk `13` and no subtype. Test the family on `sqliteCode` against `SQLITE_CODES`, the subtype on `sqliteExtendedCode` against `SQLITE_EXTENDED_CODES`. `sqliteCode` is typed `SQLiteResultCode`, so comparing it with an extended code does not compile; `sqliteExtendedCode` is typed `SQLiteExtendedResultCode | (number & {})`. What each code means: [Result and Error Codes](https://sqlite.org/rescode.html).

```typescript
import { SQLITE_EXTENDED_CODES, SQLiteError } from 'browser-sqlite';

try {
  await db.write('...');
} catch (err) {
  if (err instanceof SQLiteError) {
    switch (err.code) {
      case 'STATEMENT_FAILED':
        if (err.sqliteExtendedCode === SQLITE_EXTENDED_CODES.CONSTRAINT_UNIQUE) {
          /* already exists */
        }
        break;
      case 'WORKER_CRASHED': /* restart or notify */ break;
      case 'CLIENT_CLOSED':  /* client was shut down */ break;
    }
  }
}
```


**Read methods reject write statements.**<br>`read()`, `chunk()`, `stream()`, and `first()` reject any statement that is not a provably readable query, throwing `NOT_A_READ_QUERY`. A bare read pragma (`PRAGMA journal_mode`) is accepted; a pragma that assigns a value or takes an argument, and `PRAGMA optimize`, `incremental_vacuum` and `wal_checkpoint`, which write, must go through `write()`.

## Debugging

[`db.debug`](#clientdebug) is defined only when the client is created with the [`debug`](#debug) option — `{ debug: true }`, or a string used as the log prefix; it is `undefined` otherwise.

It is one object, updated in place: keep the reference and read it as often as you like. To keep a moment of it, `structuredClone(db.debug)` keeps the shape but an `error` comes back as a plain `Error` without its `code`, and it throws if an `error` or a `param` is not cloneable (an abort reason you passed, for instance); `JSON.stringify` keeps `code` but drops an error's `message`, and throws on a `bigint` param.

| Field | What it holds |
|---|---|
| `file`, `vfs`, `pragmas`, `name` | What the client opened, and the name its log lines carry. |
| `queue` | Callers waiting for a worker (`read`, `write`), and for the pool to exist (`gated`). |
| `workers` | One entry per slot: `index`, `generation` (0 for the slot's first worker, +1 per replacement), `name`, `creationTime`, `initializationTime`, `boot` (the step its open has reached — where an open never finishes, the step it stopped at), `status`. |
| `requests` | The client's recent requests, oldest first. |

**A request is one lease of a worker.**<br>A `read()` is one, and so is a whole transaction. It carries `kind` (`'read'` or `'write'`), `startTime` (the call), `lockTime` (the cross-tab write lock was granted — a write on a VFS whose storage other tabs share), `acquireTime` (a worker was lent), `endTime` (the worker went back, or the request failed before getting one), `worker` and `generation` (who served it), `error` (why it ended before running), `affected`, `rows` and `queries`. Its state is in its timestamps:

| `lockTime` | `acquireTime` | `endTime` | `error` | The request is |
|---|---|---|---|---|
| — | — | — | — | waiting: on another tab's write lock for a write on a shared VFS, on the pool otherwise |
| set | — | — | — | waiting on the pool |
| any | set | — | — | running |
| any | set | set | — | done |
| any | any | set | set | failed before your code received its worker |

**A query is one SQL text sent during a request.**<br>It carries `sql`, `params`, `startTime`, `firstRowTime`, `endTime`, `error`, `affected`, `rows`, `prepared` (statements SQLite had to compile; 0 when the statement cache served it) and `internal`. `rows` counts the rows the client received; a `first()` or a `stream()` you left early stops at what had arrived, which may be a chunk more than you read.

The library's own statements — the one that makes a worker see what another committed, a transaction's `BEGIN` and `COMMIT` or `ROLLBACK`, and the `SAVEPOINT`, `RELEASE` and `ROLLBACK TO` that `tx.savepoint()` and its handle send — appear among the queries with `internal: true`. A request's `rows` and `affected` count only yours.

The history keeps 50 requests per worker of the pool, and 50 queries per request; a request still waiting or running is never dropped. **It keeps `params` in memory** — the values you bound, for every query it holds. One call can make several requests: a `stream()` that meets `BUSY` takes a new lease for each attempt, and nothing links them.

---

<a id="fn-1"></a>
<sub>**1.** Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer.</sub>
