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

**webpack, rspack, and rsbuild** require no bundler-specific configuration. Add the [cross-origin isolation headers](#requirements) to your dev server and you are done.

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

`dist/worker/` is an asset directory — the worker script and its three `.wasm` siblings must travel with the built app. For the required COOP/COEP headers, see [Requirements](#requirements).

## VFS Selection

browser-sqlite delegates storage to a wa-sqlite Virtual File System (VFS). Choose based on browser support and storage requirements:

| VFS | Storage | Constraint | When to use |
|-----|---------|------------|-------------|
| `OPFSPermutedVFS` **(default)** | OPFS | None — supports `poolSize >= 1` | General purpose. Best choice for most applications. |
| `OPFSAdaptiveVFS` | OPFS | Requires JSPI (Chromium 126+) | When JSPI is available and adaptive sync strategy is desired. |
| `OPFSCoopSyncVFS` | OPFS | None — cooperative sync, no JSPI required | Broader browser compatibility fallback when JSPI is unavailable. |
| `AccessHandlePoolVFS` | OPFS | **`poolSize` must be `1`** — throws otherwise | Single-connection scenarios requiring access handle pool semantics. |
| `IDBBatchAtomicVFS` | IndexedDB | None | Fallback when OPFS is unavailable (older browsers, some mobile environments). |

When `vfs` is omitted, `OPFSPermutedVFS` is used.

For a detailed VFS comparison, see the [wa-sqlite VFS comparison](https://github.com/rhashimoto/wa-sqlite/tree/master/src/examples#vfs-comparison).

## Usage

### Initialize

```typescript
import { createSQLiteClient } from 'browser-sqlite';

const db = createSQLiteClient('myapp.sqlite', {
  poolSize: 2,                    // number of worker threads (default: 2)
  vfs: 'OPFSPermutedVFS',         // VFS selection (default: 'OPFSPermutedVFS')
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
| `vfs` | `SQLiteVFS` | `'OPFSPermutedVFS'` | VFS implementation for storage. See the [VFS Selection](#vfs-selection) table. |
| `pragmas` | `Record<string, string>` | `undefined` | SQLite PRAGMAs applied to each worker connection on open. |
| `maxWorkerRestarts` | `number` | `1` | How many times a slot may be restarted after it dies. A slot that never reached readiness is never restarted — an initial failure is deterministic and restarting only delays the diagnostic. The counter resets once a replacement has actually served a request. |
| `openTimeout` | `number` (ms) | `30_000` | How long a worker has to post `ready` after `open` is sent. On expiry the slot is failed — the most common cause is a database held under an exclusive lock by another tab. |
| `drainTimeout` | `number` (ms) | `60_000` | How long the drain loop may run in the query generator's `finally` before the worker is presumed dead and the crash path is invoked. |

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
| `NOT_A_READ_QUERY` | `read()`, `chunk()`, `stream()`, or `first()` was called with a statement that is not a provably readable query. Every PRAGMA currently counts as a write — run PRAGMAs through `write()`. |
| `CLIENT_CLOSED` | A query was queued after `close()` was called. |
| `WORKER_CRASHED` | A pool worker died and the supervisor decided not to restart it. All queued and in-flight work on that slot is rejected. |
| `TIMEOUT` | A worker did not post `ready` within `openTimeout` milliseconds. The most common cause is a database held under an exclusive lock by another tab or client. |
| `PROTOCOL_ERROR` | A message was received from a worker that could not be deserialized (`messageerror`). The worker survives; only the in-flight request is rejected. |

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

**Read methods reject write statements.** `read()`, `chunk()`, `stream()`, and `first()` reject any statement that is not a provably readable query, throwing `NOT_A_READ_QUERY`. Every PRAGMA currently counts as a write — run PRAGMAs through `write()` until a future release adds a PRAGMA allowlist.

## Requirements

> **These HTTP headers are mandatory.** Without them, `new SharedArrayBuffer()` throws a `SecurityError` and browser-sqlite cannot initialize.

browser-sqlite uses a `SharedArrayBuffer` to coordinate worker pool state. Browsers require [cross-origin isolation](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated) to create `SharedArrayBuffer` instances. Your page must be served with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Server configuration examples

**Nginx**
```nginx
add_header Cross-Origin-Opener-Policy "same-origin";
add_header Cross-Origin-Embedder-Policy "require-corp";
```

**Express**
```javascript
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
```

**Rsbuild / Vite dev server**
```typescript
// rsbuild.config.ts or vite.config.ts
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```

## Known Limitations

- **`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.
- **`SharedArrayBuffer` requires cross-origin isolation.** See the [Requirements](#requirements) section. Omitting COOP/COEP headers causes a `SecurityError` at runtime with no fallback.
- **`OPFSAdaptiveVFS` requires Chromium 126+.** This VFS uses JavaScript Promise Integration (JSPI), which is not available in Firefox or Safari as of 2025.
