# browser-sqlite

A persistent SQLite database that lives in your browser — yes, for real. Powered by [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (WebAssembly), built for (read) concurrency.

**▶ [Run the benchmarks in your own browser](https://lalexdotcom.github.io/browser-sqlite/)** — every
VFS this library ships, put through the same conformance checks and measurements, on your device.
It is the honest way to choose one: which VFS wins depends on the engine, and it changes often —
a single browser release can move the answer.

## Usage

### Initialize

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient('myapp.sqlite', {
  poolSize: 2,                    // number of worker threads (default: 2)
  vfs: 'OPFSAdaptiveVFS',         // VFS selection (default: 'OPFSAdaptiveVFS')
  build: 'async',                 // wa-sqlite build (default: the VFS's first)
  pragmas: {                      // SQLite PRAGMAs applied on open
    journal_mode: 'WAL',
    synchronous: 'NORMAL',
  },
});
```

`createSQLiteClient` spawns `poolSize` Web Worker threads immediately. Workers reach READY state asynchronously — queries made before workers are ready are queued automatically.

### Read

```typescript
type User = { id: number; name: string };

const users = await db.read<User>(
  'SELECT id, name FROM users WHERE active = ?',
  [1],
);
// users: User[]
```

Read queries are dispatched to any available worker, enabling concurrent reads.

### Write

```typescript
const { affected } = await db.write(
  'INSERT INTO users (name, email) VALUES (?, ?)',
  ['Alice', 'alice@example.com'],
);
// affected: number of rows inserted
```

Write queries are serialized through a dedicated writer worker — only one write executes at a time.

### Stream (large result sets)

```typescript
// Worker is held for the full generator lifetime — always exhaust or break.
for await (const row of db.stream<User>('SELECT * FROM large_table', [])) {
  processRow(row); // row is User
}
```

`stream()` yields individual rows without buffering the full result set in memory.
Use `chunk()` to iterate in batches: `for await (const rows of db.chunk(...))`.

### First (first row)

```typescript
const user = await db.first<User>(
  'SELECT * FROM users WHERE id = ?',
  [42],
);
// user: User | undefined
```

`first()` returns the first result row, or `undefined` if no rows match. Use it for lookups by primary key or unique field.

### Transaction

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

### Close

```typescript
await db.close();
```

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers. The returned promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed. Calling `close()` a second time returns the same promise — the operation runs exactly once.

**Stored data is not deleted.** `close()` releases workers and connections; it removes nothing, and this library does not yet expose a deletion that routes through the VFS. Removing files under `navigator.storage.getDirectory()` is only correct for the plain OPFS VFS on a closed database, and even there it leaves SQLite's `-journal` and `-wal` siblings. It is wrong elsewhere: `AccessHandlePoolVFS` keeps its databases in pre-allocated files inside one directory named after the VFS, so removing one takes capacity from the pool instead of freeing it; `IDBBatchAtomicVFS` and `IDBMirrorVFS` store nothing in OPFS at all. Treat removal as VFS-specific until an API exists.

## Install

```bash
npm install browser-sqlite
# or
pnpm add browser-sqlite
```

Requires a bundler that supports Web Workers with dynamic imports (Rsbuild, webpack 5, Vite 3+).

## Bundler Configuration

**webpack, rspack, and rsbuild** require no bundler-specific configuration.

**Vite** needs two adjustments because of how it handles dependency pre-bundling and production assets.

### Vite

```typescript
// vite.config.ts
import { cp } from 'node:fs/promises';
import { defineConfig } from 'vite';

export default defineConfig({
  // Vite pre-bundles dependencies with esbuild in dev, which rewrites
  // `import.meta.url` to the pre-bundled copy under node_modules/.vite/deps/.
  // browser-sqlite locates its worker relative to its own module URL, so the
  // rewrite sends it to a path Vite never populates. Excluding the package
  // from pre-bundling keeps the URL pointing at the real file.
  optimizeDeps: { exclude: ['browser-sqlite'] },

  plugins: [
    {
      // In a production build Vite copies the worker into the output but does
      // not follow the `new URL('wa-sqlite.wasm', import.meta.url)` references
      // inside it — files under node_modules are not re-transformed. The .wasm
      // files must therefore be placed beside the emitted worker by hand.
      name: 'copy-browser-sqlite-wasm',
      apply: 'build',
      async closeBundle() {
        await cp('node_modules/browser-sqlite/dist/worker', 'dist/assets', {
          recursive: true,
        });
      },
    },
  ],
});
```

`dist/worker/` is an asset directory — the worker script and its three `.wasm` siblings must travel with the built app.

## Browser support

| Chrome | Firefox | Safari |
|---|---|---|
| 92+ | 95+ | 15.4+ |

## VFS Selection

browser-sqlite delegates storage to a
[wa-sqlite Virtual File System](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#readme)
(VFS). **When `vfs` is omitted, `OPFSAdaptiveVFS` is used.**

Choose based on browser support and storage requirements — and, for anything to do
with speed or concurrency, on [the benchmark page](https://lalexdotcom.github.io/browser-sqlite/)
run on the browsers you actually target. This table describes what each VFS *is*;
only your device can say what it *costs* there.

<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->

| VFS | Builds | Browser compatibility | Pool size | Shared between connections | Survives close | Memory |
|-----|--------|-----------------------|-----------|----------------------------|----------------|--------|
| `OPFSAdaptiveVFS` **(default)** | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+ [(*)](#-reduced-mode)<br>Safari 15.4+/27+ [(*)](#-reduced-mode)<br>Android 109+/?<br>iOS 15.4+ (no jspi) [(*)](#-reduced-mode) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSWriteAheadVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 121+/137+<br>Android 121+/? | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSCoopSyncVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+ (no jspi) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `AccessHandlePoolVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+ (no jspi) | **1** — it cannot share access handles between connections | No | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBBatchAtomicVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+ (no jspi) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBMirrorVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+ (no jspi) | **1** — its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright | No | Yes | **Whole database in RAM**, multiplied by `poolSize` |
| `OPFSAnyContextVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 111+/153+<br>Safari 15.4+/27+<br>Android 109+/?<br>iOS 15.4+ (no jspi) | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `MemoryVFS` | [`sync`](#build-sync), [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+ (no jspi) | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |
| `MemoryAsyncVFS` | [`async`](#build-async), [`jspi`](#build-jspi) | Chrome 92+/137+<br>Firefox 95+/153+<br>Safari 15.4+/27+<br>Android 92+/?<br>iOS 15.4+ (no jspi) | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |

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

Both halves are measured by `bench/index.html`, which runs in your own browser;
its `no-read-inside-transaction` and `pool-blocking` rows are the two
observations above.

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
| 137+ | 153+ | 27+ | Yes | **No** |

JavaScript Promise Integration — the same asynchrony handled by the engine rather than by Asyncify. Opt-in, and no default uses it, so its narrower availability constrains nobody who does not ask for it.


<!-- END GENERATED BUILD TABLE -->

## Advanced

### bulkWrite

```typescript
const rows = db.bulkWrite('events', ['id', 'kind', 'at']);
for (const event of events) rows.enqueue(event);
const affected = await rows.close();
```

Batches inserts to stay under SQLite's variable limit (`SQLITE_MAX_VARS`,
32 766), flushing whenever the next row would cross it. `close()` flushes the
remainder and resolves with the total number of rows written.

Single-use: `enqueue()` and `close()` throw once closed. A batch that fails
rejects with a `BulkWriteError` carrying `rowsWritten` and `rowsNotWritten` — a
multi-row INSERT is statement-atomic, so the failing batch wrote nothing.

### output

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

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `poolSize` | `number` | `2` | Number of Web Workers spawned in the pool. A larger pool allows more concurrent reads but uses more memory. Must be `1` with `AccessHandlePoolVFS`. |
| `vfs` | `SQLiteVFS` | `'OPFSAdaptiveVFS'` | VFS implementation for storage. See the [VFS Selection](#vfs-selection) table. |
| `build` | `SQLiteBuild` | first build the VFS declares | Which wa-sqlite WebAssembly build to load: `'sync'`, `'async'`, or `'jspi'`. Throws `INVALID_OPTION` at construction if the VFS does not support it. See [Builds](#builds). |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. A slot that never reached readiness is never restarted — an initial failure is deterministic and restarting only delays the diagnostic. The counter resets once a replacement has actually served a request. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to post `ready` after `open` is sent. On expiry the slot is failed — the most common cause is a database held under an exclusive lock by another tab. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run in the query generator's `finally` before the worker is presumed dead and the crash path is invoked. |
| `debug` | `string \| boolean` | `undefined` | Enables lifecycle logging. A string value is used as the log prefix; `true` falls back to the client prefix (e.g. `"SQLite 1"`). Only lifecycle events are logged — worker created, ready, open-error, crash, restart, eviction, close, and skipped staging sweep. No line per query. Off by default. When enabled, `db.debug` also exposes a live introspection state tree for query throughput and worker status. |

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
- **`build: 'jspi'` is not available everywhere.** JavaScript Promise Integration ships in Firefox from 153 (caniuse.com, checked 2026-08-24) and in Chromium; Safari support is not established here. It is opt-in and the default build does not use it, so this constrains nobody who does not ask for it. Earlier revisions of this file called JSPI Chromium-only; that was never sourced, and running the conformance suite on Firefox 153 disproved it.
- **`OPFSWriteAheadVFS` requires Chrome 121+ and degrades silently elsewhere.** It opens access handles with `mode: 'readwrite-unsafe'` — a proposed feature recorded as unsupported for Firefox and Safari in MDN browser-compat-data (checked 2026-08-24) — and unknown dictionary members are ignored rather than rejected — so on another browser the first connection opens, the second cannot take the handle, and the pool breaks with no error naming the cause.
- **`OPFSCoopSyncVFS` does not read concurrently, and stalls unpredictably under a pool.** Unlike the other OPFS VFS it extends `FacadeVFS` directly rather than `WebLocksMixin(FacadeVFS)` (wa-sqlite v1.1.2, `src/examples/OPFSCoopSyncVFS.js:44` against `OPFSAdaptiveVFS.js:55`), so it implements its own locking and silently ignores the `lockPolicy: 'shared'` this library constructs every VFS with. It holds one *exclusive* access handle and rotates it between workers instead of holding one per connection. Measured with `bench/index.html` on 2026-08-25 at `poolSize: 4`, Chromium 151 and Firefox 153: a read issued while a write transaction is open is **never served on either engine** — the pool acquisition blocks before any `AbortSignal` is consulted — where `IDBBatchAtomicVFS`, `IDBMirrorVFS` and `OPFSAnyContextVFS` serve it every time. Its bulk insert of 10 000 rows either finishes in about 70–90 ms or **exceeds 30 seconds**, with no middle ground and no consistency across builds or runs; on both engines it stranded whole benchmark columns on that row. None of this depends on `readwrite-unsafe`: unlike the reduced mode described above, it happens on Chromium too.
- **Read-your-own-writes is guaranteed within a tab, not across tabs.** See the
  caveat under [Error handling](#error-handling).

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

`bench/index.html` is the page published above. It is one self-contained file
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

`node scripts/bench-check.mjs [chromium|firefox] [--all]` drives the page under
Playwright and asserts that it still works — it is run by hand and deliberately
not wired into CI. It checks the *page*, never that a VFS passes: a red cell can
be a correct report about the engine you are on.
