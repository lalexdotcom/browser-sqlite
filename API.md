# API

Every method, property and option of [browser-sqlite](README.md).

[*client*.id](#clientid) · [*client*.name](#clientname) · [*client*.file](#clientfile) · [*client*.vfs](#clientvfs) · [*client*.build](#clientbuild)

[createSQLiteClient()](#createsqliteclient) · [*client*.read()](#clientread) · [*client*.write()](#clientwrite) · [*client*.stream()](#clientstream) · [*client*.chunk()](#clientchunk) · [*client*.first()](#clientfirst) · [*client*.transaction()](#clienttransaction) · [*client*.bulkWrite()](#clientbulkwrite) · [*client*.output()](#clientoutput) · [*client*.inspect()](#clientinspect) · [*client*.close()](#clientclose) · [deleteDatabase()](#deletedatabase) · [inspectDatabase()](#inspectdatabase)

**[Queries](#queries)**: [Writing queries](#writing-queries) · [How they run](#how-they-run)

**[Interrupting a call](#interrupting-a-call)** · **[Error handling](#error-handling)**

## createSQLiteClient

`createSQLiteClient` spawns `poolSize` Web Worker threads immediately. Workers reach READY state asynchronously — queries made before workers are ready are queued automatically.

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient('myapp.sqlite', {
  poolSize: 2,                    // number of worker threads (default: 2)
  vfs: 'OPFSAdaptiveVFS',         // required — see Browser compatibility
  build: 'async',                 // wa-sqlite build (default: the VFS's first)
  pragmas: {                      // SQLite PRAGMAs applied on open
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
  },
});
```

`vfs` is the only option with no default — see our [recommendations](VFS.md#recommendations) and the [full VFS documentation](VFS.md) to choose your own.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2`, capped to the VFS's `maxPoolSize` | Web Workers in the pool. |
| `vfs` | `SQLiteVFS` | — (required) | Where the database is stored.<br>See [Recommendations](VFS.md#recommendations). |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite WebAssembly build to load.<br>See [Builds reference](VFS.md#builds-reference). |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Where the workers fetch their `.wasm`. |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to report ready after `open` is sent. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run before the worker is presumed dead. |
| `debug` | `string \| boolean` | `undefined` | Lifecycle logging, and the `db.debug` introspection tree. |
| `onWorkerLost` | `(event: WorkerLostEvent) => void` | `undefined` | Called when a worker is lost for good. |

**`poolSize` delays your first query.** Nothing is served until every worker has opened, and the opens are serialized across the origin, so the wait grows with the pool. A VFS that holds a single connection caps it at `1` and throws if you pass more; omitting it never throws.

**`build`** throws `INVALID_OPTION` at construction when the VFS does not declare that build, naming the ones it does.

**`wasmUrl`** is read once, at construction, and throws `INVALID_OPTION` there if the value is not a URL. A string is a directory resolved against the page — relative, absolute or a full URL, trailing slash optional. A callback receives the resolved `build` and names one file, for a bundler-emitted asset carrying a content hash. Serving from another origin needs CORS and `Content-Type: application/wasm`.

**`maxWorkerRestarts`** counts from the last replacement that actually served a request. A slot that fails to *open* is retried once, and only if another worker did open — when none did, the failure is a configuration error and the client fails immediately.

**`openTimeout`** most often expires on a database another tab holds under an exclusive lock. **A pool that will never open takes up to twice this before your first query rejects**, because a failed slot is retried once when another slot opens; at the default that is about a minute with nothing reported.

**`debug`** logs lifecycle events only — worker created, ready, open-error, crash, restart, worker lost, close, skipped staging sweep — never one line per query. A string is used as the log prefix, `true` falls back to the client name. One thing is logged even when it is off: a permanently lost worker always warns, because a pool quietly smaller than `poolSize` is not something to discover later.

**`onWorkerLost`** receives the slot index, how many workers are left, the requested `poolSize`, and the error. It fires before the client fails if that worker was the last. A callback that throws is caught and warned about; it cannot break the pool.

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

Sends a write query and returns how many rows it affected.

```typescript
const { affected } = await db.write(
  'INSERT INTO users (name, email) VALUES (?, ?)',
  ['Alice', 'alice@example.com'],
);
// affected: number of rows inserted
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the query. Rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before it is aborted and rejected with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |

See [Writing queries](#writing-queries).

## *client*.stream

Yields individual rows without buffering the full result set in memory.
Use [`chunk()`](#clientchunk) to iterate in batches instead.

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

Runs a callback inside a transaction. Returning commits, throwing rolls back
and re-throws.

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

> [!WARNING]
> **A write transaction holds the only writing slot in the origin for as long as
> its callback runs.** Writes are serialized across every client and every tab, so
> a callback that waits on something slow makes every other writer in the origin
> wait with it — not only the ones on this client. Keep the callback to the
> statements it needs.

**One worker serves the whole callback**, so the transaction is genuinely isolated rather than merely wrapped in `BEGIN`. `tx` carries the same querying surface as the client — `read`, `write`, `chunk`, `stream`, `first`, `bulkWrite`, `output` — plus `commit` and `rollback`. A `chunk()` or `stream()` generator abandoned inside the callback is closed before the transaction commits or rolls back, the same as anywhere else — see [How they run](#how-they-run).

**Rows land only on a `COMMIT` that succeeds.** Everything else rolls back: a callback that throws, an abort, a `COMMIT` that fails, and — under `autoCommit: false` — a callback that returns without calling `tx.commit()`. Catching your own statement's rejection does not let you commit around an abort. If the rollback itself fails the worker is evicted, rather than returned to the pool holding an open transaction.

**An abort reaches further than a statement.** `signal` and `timeout` abandon the transaction at any point. The callback is not interrupted — it runs on — but every statement it issues afterwards rejects. `BEGIN`, `COMMIT` and `ROLLBACK` are the exception: they carry no signal, so an abort raised while one is in flight lands when it settles.

See [Writing queries](#writing-queries).

## *client*.bulkWrite

Returns an `enqueue()` / `close()` pair that batches rows into multi-row inserts.

```typescript
const rows = db.bulkWrite('events', ['id', 'kind', 'at']);
for (const event of events) await rows.enqueue(event);
const affected = await rows.close();
```

| Option | Type | Default | Description |
|---|---|---|---|
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason`.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`.<br>See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

**Single-use.** `enqueue()` and `close()` throw once closed. A batch is flushed whenever the next row would cross SQLite's variable limit; `close()` flushes what is left and resolves with the total.

**Batches are committed as they flush, so a load is never all-or-nothing.** A failure and an abort both stop it and leave the rows already written in place — run `bulkWrite()` on a `tx` if you need all or nothing. Neither can tear a batch: a multi-row `INSERT` is statement-atomic, so a failing batch wrote nothing and an abort lands between batches. A failure rejects `close()` with a `SQLiteBulkWriteError` carrying `rowsWritten` and `rowsNotWritten`.

**Always call `close()`, including after `enqueue()` has thrown.** It is the only path that detaches the abort listener from your `signal` and clears the `timeout` timer, and it is where the outcome is reported: `signal.reason` when the load was aborted, a `SQLiteBulkWriteError` carrying the counts when a batch failed. Rows already flushed are written either way — skipping `close()` leaks those two and tells you nothing about what landed.

Await `enqueue()` to be slowed to the speed of the database. It resolves immediately while fewer than `queueSize` rows are queued for writing, and only defers beyond that — so a producer that awaits every row never holds more than that many unwritten rows. Ignoring the returned promise is legal and loads exactly as before: the bound is an offer, not a guarantee, and only you can take it. `queueSize` counts rows, not bytes: if your columns carry blobs, set it yourself.


## *client*.output

Builds a table from a schema declaration and fills it through the same
`enqueue()` / `close()` pair as [`bulkWrite()`](#clientbulkwrite).

```typescript
const out = db.output(
  'products',
  { id: 'INTEGER', name: 'TEXT', price: { type: 'REAL', required: true } },
  { indexes: ['name', { columns: ['name', 'price'], unique: true }] },
);
await out.enqueue({ id: 1, name: 'widget', price: 9.99 });
const affected = await out.close();
```

| Option | Type | Default | Description |
|---|---|---|---|
| `indexes` | `Index[]` | — | Indexes built after the swap, under their final names. A column name, an array of them, or `{ columns, unique }`. |
| `signal` | `AbortSignal` | — | Aborts the load between batches. `close()` rejects with `signal.reason` and the target is untouched.<br>See [Interrupting a call](#interrupting-a-call). |
| `timeout` | `number` (ms) | — | Milliseconds before the load is aborted. `close()` rejects with `OPERATION_TIMEOUT`; the target is untouched.<br>See [Interrupting a call](#interrupting-a-call). |
| `queueSize` | `number` | 2 batches | Rows queued for writing above which `enqueue()` defers. A batch is `floor(32766 / columns)` rows. |

**The target is replaced atomically, or not at all.** Rows land in a staging table and the swap happens at `close()`, so a reader querying mid-load sees the old data, never a half-filled table — and a target that did not exist appears only at `close()`. An abort is observationally a no-op: the staging table is dropped, nothing else is touched, and whatever was in the target before is still there, whole.

**Always call `close()`, for the reasons it matters on [`bulkWrite()`](#clientbulkwrite) and one more:** it is what drops the staging table and releases the lock the load holds, on the failing path as much as on the succeeding one. It is single-use, like `bulkWrite()`.

**Inside a transaction, `output()` costs more than it looks.** On its own it loads rows outside any transaction and holds the write lock only for the final swap. Called on a `tx`, the entire load runs inside your transaction — every other write, in this tab and in others, waits for it to finish.

## *client*.inspect

Reports who is live on this client's database, in every tab of the origin.

```typescript
const { self, siblings, tabs, write } = await db.inspect();
```

It is the same census as [`inspectDatabase`](#inspectdatabase), where the semantics and the caveats are documented. The difference is only the split: `db.inspect()` separates `self`, this client's own entry, from `siblings`, everyone else, where `inspectDatabase` returns one `clients` list. `self` is `null` when this client's own marker is not in the snapshot.

After the client's own [`close()`](#clientclose) it throws `CLIENT_CLOSED`, like every other method on it. [`inspectDatabase`](#inspectdatabase) answers the same question afterwards — `inspectDatabase(db.file, { vfs: db.vfs })`, which is what those two properties are for.

## *client*.close

Drains in-flight work, rejects queued work, closes each database connection,
then terminates all workers.

```typescript
await db.close();
```

**`close()` is async.** Always `await db.close()`: the promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed, and discarding it means the caller cannot tell when teardown is complete. Calling it a second time returns the same promise — the operation runs exactly once.

**Stored data is not deleted.** `close()` releases workers and connections; it removes nothing. To remove the database itself, use [`deleteDatabase`](#deletedatabase).

**A page reload is not a close, and some engines make you wait for it.** Navigating away or
reloading discards the page without running `close()`, and the browser does not always release
the underlying connection at once — the next page's open can then exhaust its
[`openTimeout`](#options) and report `TIMEOUT`.<br>
**If your application reloads** while a client is open, close it first:

```typescript
window.addEventListener('pagehide', () => {
  void db.close();
});
```

`pagehide` fires where `unload` no longer does.

## deleteDatabase

Removes a database and the `-journal` / `-wal` files SQLite may have left beside it.

```typescript
import { deleteDatabase } from 'browser-sqlite';

await deleteDatabase('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });
```

| Option | Type | Default | Description |
|---|---|---|---|
| `vfs` | `SQLiteVFS` | — (required) | The VFS the database was created with. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite build to load. It does not affect where the database lives — only which builds can instantiate the VFS. |
| `wasmUrl` | `string \| ((build: SQLiteBuild) => string)` | `undefined` | Same meaning as on [`createSQLiteClient`](#options). A deployment that needs it to open a database needs it to delete one. |

Deleting a database that is not there throws — most often because `vfs` is not the one it was created with.

What a VFS keeps for itself is left alone — the IndexedDB store shared by every database that VFS holds on this origin, and the `AccessHandlePoolVFS` directory whose files are its reusable capacity. The deleted database's own bytes are freed in both cases.

> [!WARNING]
> Some VFS share one file per database name, so deleting through any of them deletes what
> the others created: <!-- BEGIN GENERATED SHARED VFS — edit `layout` in src/types.ts -->
> `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS`, `OPFSCoopSyncVFS` and `OPFSAnyContextVFS`.
> <!-- END GENERATED SHARED VFS -->

**The database must not be open, in this tab or any other.** `DATABASE_IN_USE` says a client still holds it, and retrying will not help — closing every client on it is what releases it. A client your application stopped using but never closed keeps blocking until its tab goes, and this library cannot revoke a connection it did not open: another library or native code on the same origin is invisible to it.

The other three codes: `DATABASE_NOT_FOUND` means there was nothing at that name. `BUSY` is the transient case — another open or another delete was in flight at that moment, and retrying is the remedy. `TIMEOUT` means the VFS could not answer within 30 seconds.


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

**"Tab" means realm.** A same-origin iframe in your own page is a different tab here: it has its own identity, so `sameTab` is `false` for it.

**A snapshot, never a permission.** It is stale the instant it resolves. An empty roster does not mean a database can be deleted — a tab may open between the two calls, and [`deleteDatabase`](#deletedatabase) raising `DATABASE_IN_USE` remains the only authority. An empty roster also does not distinguish a database nobody holds from one that does not exist; `DATABASE_NOT_FOUND` is what says that.

**Polling is on the call.** Nothing is kept between two calls, and there is no event to subscribe to. A call makes no worker round trip, and the tab's identity is resolved and cached once, so subsequent calls take no lock — polling cannot slow a query down. Do not stack calls: a background tab has its timers throttled, and an interval that fires without awaiting the previous answer will queue them up.

`MemoryVFS` and `MemoryAsyncVFS` throw `INVALID_OPTION`: their pages live in the worker that opened them, so two clients are two databases and there is nothing to share. Where the Web Locks API is missing, `inspectDatabase` and `db.inspect()` throw `UNSUPPORTED` rather than report zero.

## Queries

### Writing queries

**Pass values as `?` parameters rather than building them into the SQL.** Each worker keeps a
cache of 32 prepared statements, keyed on the exact SQL string. Interpolating a value makes
every call a new key, so nothing is ever reused and every query is recompiled. Generated SQL
is sometimes unavoidable — `IN (?, ?, ?)` changes shape with the list — and it still works;
it simply cannot be cached.

### How they run

Read queries are dispatched to any available worker, so several run at once.

Write queries are serialized per database across the whole origin — one at a time, across every client and every tab, not only within the client that issued them.

**A generator holds its worker for its whole lifetime.** [`stream()`](#clientstream) and [`chunk()`](#clientchunk) keep the worker that serves them until the loop ends, so always exhaust the generator, `break` out of it, or call its `return()` — `await using` does the same where your engine has the syntax. One you simply drop is recovered only when the engine collects it, which is no schedule to rely on; a `timeout` or a `signal` is what gives it a deadline. Prefer `chunk()` where the work is per-batch — one `INSERT` per chunk rather than per row.

## Interrupting a call

`signal` and `timeout` both stop the *wait* immediately: `signal` rejects with `signal.reason`,
`timeout` rejects with `OPERATION_TIMEOUT`.

```typescript
// Rejects with OPERATION_TIMEOUT.
const rows = await db.read('SELECT * FROM large_table', [], { timeout: 5_000 });

// Rejects with the signal's reason (a DOMException TimeoutError).
const rows = await db.read('SELECT * FROM large_table', [], {
  signal: AbortSignal.timeout(5_000),
});
```

> [!IMPORTANT]
> Whether either also stops the statement execution depends on the build you are
> running, not on the VFS:
>
> - `async` and `jspi` interrupt it everywhere
> - `sync` only when your page is cross-origin isolated
>
> Which builds a VFS offers, and which one it defaults to, are in the
> [VFS reference](VFS.md#vfs-reference).

**`timeout` counts wall clock from the call, and your own time counts against it**: the wait for
a free pool worker, the wait for another tab's write lock, and every pause you take yourself —
between two chunks of a `stream()`, inside a `transaction()` callback, between two `enqueue()`
calls on a `bulkWrite()`. It aborts through the same path a `signal` does, so the same limit
applies, and it is a browser timer: a background tab that throttles `setTimeout` may fire it
late. `AbortSignal.timeout()` behaves identically.

Where the abort does not reach the statement, the call rejects but the statement runs to its end
on its worker, which stays unavailable until it does. The pool's other workers are unaffected.
Two ways out, and you may want neither.

Serving the page **cross-origin isolated** is the first. Two header sets do it, and each costs
something:

- **`Cross-Origin-Opener-Policy: same-origin` together with
  `Cross-Origin-Embedder-Policy: require-corp`** — works in every engine. Every cross-origin
  subresource must then opt in through `Cross-Origin-Resource-Policy` or CORS, so
  third-party images, fonts, scripts and iframes stop loading unless they cooperate; and
  `same-origin` severs the opener link with cross-origin popups, which breaks sign-in and
  payment windows that depend on it.
- **`Document-Isolation-Policy: isolate-and-require-corp`** — Chromium only; Firefox ignores
  it, so it cannot be your only measure on a cross-browser deployment. Cross-origin
  subresources still need `Cross-Origin-Resource-Policy`, but no `Cross-Origin-Opener-Policy`
  is involved, so popups and opener relationships keep working and the isolation applies to
  this document rather than to everything around it.

The second is `build: 'async'`, which interrupts without any hosting change — but it is slower
wherever a query walks rows. Full scans, paged reads and bulk loads pay for it; point reads,
write latency and read concurrency do not.

## Error handling

Errors raised by this library are instances of `SQLiteError`, exported from the package entry point.

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
| `GENERATOR_ABANDONED` | A statement was issued on a worker that still had a query in flight. Statements on one worker must not overlap, and inside a `transaction()` they all share one worker. The usual cause is a `chunk()` or `stream()` generator left open — exhaust it, `break` out of it, or call its `return()`. |
| `READ_ONLY_TRANSACTION` | raised when a write statement, `bulkWrite()` or `output()` is used inside a transaction opened with `readOnly: true`. |

Discriminate on `error.code` or `error.name` — they carry the same value, so `err.name` reads the way `'AbortError'` does on a DOM `AbortError`.

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

---

<a id="fn-1"></a>
<sub>**1.** Rows per chunk crossing the worker boundary. Back-pressure grants credits per chunk with a window of 2, so the worker may run up to `2 × chunkSize` rows ahead of the consumer.</sub>
