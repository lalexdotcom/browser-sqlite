# browser-sqlite

A persistent SQLite database that lives in your browser — yes, for real. Powered by [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) (WebAssembly), built for (read) concurrency.

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

## VFS Selection

browser-sqlite delegates storage to a wa-sqlite Virtual File System (VFS). Choose based on browser support and storage requirements:

<!-- BEGIN GENERATED VFS TABLE — edit VFS_CAPABILITIES in src/types.ts, then run `pnpm docs:vfs` -->

| VFS | Builds | Pool size | Shared between connections | Survives close | Memory |
|-----|--------|-----------|----------------------------|----------------|--------|
| `OPFSAdaptiveVFS` **(default)** | `async`, `jspi` | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSWriteAheadVFS` | `sync`, `async`, `jspi` | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `OPFSCoopSyncVFS` | `sync`, `async`, `jspi` | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `AccessHandlePoolVFS` | `sync`, `async`, `jspi` | **1** — it cannot share access handles between connections | No | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBBatchAtomicVFS` | `async`, `jspi` | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `IDBMirrorVFS` | `async`, `jspi` | Any | Yes | Yes | **Whole database in RAM**, multiplied by `poolSize` |
| `OPFSAnyContextVFS` | `async`, `jspi` | Any | Yes | Yes | Page cache only, bounded by `PRAGMA cache_size` |
| `MemoryVFS` | `sync`, `async`, `jspi` | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |
| `MemoryAsyncVFS` | `async`, `jspi` | **1** — its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently | No | **No — volatile** | **Whole database in RAM**, multiplied by `poolSize` |

<!-- END GENERATED VFS TABLE -->

One property the table cannot show, because verifying it means timing something
and this project's CI runs tests rather than benchmarks: **on a browser without
`readwrite-unsafe` access handles, any VFS that rotates a single exclusive OPFS
handle serializes the whole pool for the duration of a long uninterruptible
statement.** That covers `OPFSAdaptiveVFS` in its degraded mode and
`OPFSCoopSyncVFS`. `IDBMirrorVFS`, `OPFSAnyContextVFS` and `IDBBatchAtomicVFS`
hold no such handle and are unaffected.

Browsers nobody has run are marked *not measured* rather than presumed
compatible.

When `vfs` is omitted, `OPFSAdaptiveVFS` is used.

### Builds

Each VFS runs on one or more wa-sqlite WebAssembly builds: `sync`, `async` (Asyncify), or `jspi` (JavaScript Promise Integration, Chromium-only). The `build` option selects one. Omitted, the first build the VFS declares is used — `async` for the default VFS. A pair the VFS does not support throws a `SQLiteError` with code `INVALID_OPTION` at construction, naming the builds it does support. The pairing is declared in one place, `VFS_CAPABILITIES`, which is also what the `SQLiteVFS` type is derived from.

For a detailed VFS comparison, see the [wa-sqlite VFS comparison](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison).

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

### Advanced

For batch inserts, schema-driven table replacement, or explicit transactions, see:
- `db.bulkWrite(table, keys)` — batches inserts within `SQLITE_MAX_VARS` limit
- `db.output(table, schema, options)` — drops, recreates, and populates a table from a schema definition
- `db.transaction(callback, options)` — wraps operations in a SQLite transaction with auto-commit and rollback

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

### Close

```typescript
await db.close();
```

Drains in-flight work, rejects queued work, closes each database connection, then terminates all workers. The returned promise settles once every worker has closed and been terminated, or once `drainTimeout` has elapsed. Calling `close()` a second time returns the same promise — the operation runs exactly once.

**OPFS files are not deleted.** `close()` does not remove any OPFS database files. To delete them, use `navigator.storage.getDirectory()` directly.

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

browser-sqlite requires no special HTTP headers. OPFS access handles work in a plain worker context; cross-origin isolation is not needed. The default build needs no browser opt-in; only `build: 'jspi'` does, and JSPI is Chromium 126+ — that is an unrelated browser constraint, not a header requirement.

Note: the "Coop" in `OPFSCoopSyncVFS` stands for *cooperative*, not the `Cross-Origin-Opener-Policy` header.

## Known Limitations

- **`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.
- **`build: 'jspi'` requires Chromium 126+.** JavaScript Promise Integration is not available in Firefox or Safari as of 2025. It is opt-in; the default build does not use it.
- **`OPFSWriteAheadVFS` is Chromium-only and degrades silently elsewhere.** It opens access handles with `mode: 'readwrite-unsafe'`, a proposed feature no other engine implements, and unknown dictionary members are ignored rather than rejected — so on another browser the first connection opens, the second cannot take the handle, and the pool breaks with no error naming the cause.
- **Read-your-own-writes is guaranteed within a tab, not across tabs.** See the
  caveat under [Error handling](#error-handling).
