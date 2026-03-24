# browser-sqlite

Browser SQLite with concurrent read / serial write isolation, backed by Web Workers and [wa-sqlite](https://github.com/rhashimoto/wa-sqlite).

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

## Install

```bash
npm install browser-sqlite
# or
pnpm add browser-sqlite
```

browser-sqlite is a browser-only library. It requires a bundler that supports Web Workers with dynamic imports (Rsbuild, webpack 5, Vite 3+).

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
for await (const chunk of db.stream<User>(
  'SELECT * FROM large_table',
  [],
  { chunkSize: 100 },
)) {
  processChunk(chunk); // chunk is User[]
}
```

`stream()` yields rows in chunks without buffering the full result set in memory.

### One (first row)

```typescript
const user = await db.one<User>(
  'SELECT * FROM users WHERE id = ?',
  [42],
);
// user: User | undefined
```

`one()` automatically aborts after the first result row. Use it for lookups by primary key or unique field.

### Advanced

For batch inserts, schema-driven table replacement, or explicit transactions, see:
- `db.bulkWrite(table, keys)` — batches inserts within `SQLITE_MAX_VARS` limit
- `db.output(table, schema, options)` — drops, recreates, and populates a table from a schema definition
- `db.transaction(callback, options)` — wraps operations in a SQLite transaction with auto-commit and rollback

### Close

```typescript
db.close();
```

Terminates all worker threads. Does **not** delete OPFS files — see Known Limitations.

## Known Limitations

- **Browser-only.** browser-sqlite uses Web Workers, OPFS, and `SharedArrayBuffer`. There is no Node.js support.
- **OPFS files persist after `close()`.** `db.close()` terminates workers but does not delete database files from the Origin Private File System. Files persist across page loads. To delete OPFS files, use the [`navigator.storage.getDirectory()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory) API directly.
- **`AccessHandlePoolVFS` requires `poolSize: 1`.** Passing `poolSize > 1` with this VFS throws synchronously at client creation time.
- **`SharedArrayBuffer` requires cross-origin isolation.** See the [Requirements](#requirements) section. Omitting COOP/COEP headers causes a `SecurityError` at runtime with no fallback.
- **`OPFSAdaptiveVFS` requires Chromium 126+.** This VFS uses JavaScript Promise Integration (JSPI), which is not available in Firefox or Safari as of 2025.
