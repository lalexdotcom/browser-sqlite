# INTEGRATIONS.md — External Integrations

## Primary: wa-sqlite (SQLite in WebAssembly)
- **Package:** `github:rhashimoto/wa-sqlite#v1.0.9`
- **Role:** Core SQLite engine compiled to WASM
- **Usage:** Loaded dynamically inside Web Workers via lazy imports
- **Entry points in `src/worker.ts`:**
  - `wa-sqlite/src/sqlite-api.js` — `Factory` function for SQLite API
  - `wa-sqlite/src/sqlite-constants.js` — `SQLITE_ROW` constant
  - `wa-sqlite/dist/wa-sqlite.mjs` — sync WASM build
  - `wa-sqlite/dist/wa-sqlite-async.mjs` — async WASM build
  - `wa-sqlite/dist/wa-sqlite-jspi.mjs` — JSPI WASM build

## VFS Backends (Virtual File System)
All VFS modules are loaded lazily from `wa-sqlite/src/examples/`:

| VFS | Module | Use Case |
|---|---|---|
| `OPFSPermutedVFS` | `wa-sqlite-async.mjs` | Default; OPFS async, permuted page layout |
| `OPFSAdaptiveVFS` | `wa-sqlite-jspi.mjs` | OPFS with JSPI (requires Chrome 117+) |
| `OPFSCoopSyncVFS` | `wa-sqlite.mjs` | Sync OPFS using SAB cooperative locking |
| `AccessHandlePoolVFS` | `wa-sqlite.mjs` | AccessHandle pool (single-worker only) |
| `IDBBatchAtomicVFS` | `wa-sqlite-async.mjs` | IndexedDB-based storage |

## Browser APIs Required
| API | Used by | Purpose |
|---|---|---|
| `Web Workers` | `src/client.ts` | Spawn worker threads for SQLite execution |
| `SharedArrayBuffer` | `src/orchestrator.ts` | Cross-thread worker state synchronization |
| `Atomics` | `src/orchestrator.ts` | Lock-free atomic operations on SAB |
| `OPFS` (Origin Private File System) | `wa-sqlite VFS` | Persistent database file storage |
| `IndexedDB` | `IDBBatchAtomicVFS` | Alternative persistent storage |
| `import.meta.url` | `src/client.ts` | Dynamic import of worker bundle |

## Logging — @lalex/console
- **Package:** `@lalex/console 2.0.0-rc.1`
- **Usage:** `Logger.scope('sqlite/client')`, `Logger.scope('sqlite/worker')`
- API: `LL.debug()`, `LL.info()`, `LL.warn()`, `LL.verb()`, `LL.wth()`, `LL.error()`
- Levels configurable per-module via `LL.level = 'info'`

## Async Utilities — @lalex/promises
- **Usage:** `import { defer } from '@lalex/promises'`
- Provides `defer<T>()` for manual Promise resolution (used for worker init and chunk streaming)

## No External APIs or AuthN
- No network API calls
- No authentication providers
- No database servers — SQLite runs entirely in-browser via WASM
