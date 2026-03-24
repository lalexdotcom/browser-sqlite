# ARCHITECTURE.md — Architecture

## Pattern
**Web Worker Pool Architecture** — SQLite runs entirely inside dedicated Web Workers, with the main thread
acting as client-side coordinator. Cross-thread synchronization uses `SharedArrayBuffer` + `Atomics`.

## Layers

```
┌─────────────────────────────────────────────────┐
│  Consumer (application code)                    │
│  const db = createSQLiteClient('mydb.sqlite')   │
│  db.read() / db.write() / db.stream() / db.one()│
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  Client Layer  src/client.ts                    │
│  - Worker Pool management (N workers)           │
│  - Read/write separation (dedicated writer)     │
│  - Request queuing (readerQueue / writerQueue)  │
│  - Streaming result aggregation                 │
│  - AbortSignal / abort propagation             │
└────────────────┬────────────────────────────────┘
                 │  postMessage / onmessage
┌────────────────▼────────────────────────────────┐
│  Orchestrator  src/orchestrator.ts              │
│  - SharedArrayBuffer: init lock + worker status │
│  - Atomics.compareExchange for mutex             │
│  - Atomics.wait / Atomics.notify for blocking   │
│  - Worker lifecycle states (-3 → 100)           │
└────────────────┬────────────────────────────────┘
                 │  SharedArrayBuffer (cross-thread)
┌────────────────▼────────────────────────────────┐
│  Worker Layer  src/worker.ts                    │
│  - wa-sqlite WASM initialization (lazy)         │
│  - VFS registration and DB open                 │
│  - Query execution (statement iteration)        │
│  - Chunked result streaming (configurable size) │
│  - Abort detection via Atomics                  │
└─────────────────────────────────────────────────┘
```

## Worker Lifecycle State Machine
States defined in `src/orchestrator.ts` as `WorkerStatuses`:

```
EMPTY (-3) → NEW (-2) → INITIALIZING (-1) → INITIALIZED (0) → READY (10)
                                                                    ↓        ↑
                                                              RUNNING (50) → DONE (100)
                                                              ABORTING (99) ↗
```

## Data Flow — Query Execution

1. Consumer calls `db.read(sql, params)`
2. Client calls `acquireNextWorker(isWrite)` — waits if pool busy
3. Worker designated as writer if write op
4. Client sends `postMessage({ type: 'query', callId, sql, params, options })`
5. Worker executes `sqlite.statements()` iteration, yields rows in chunks
6. Worker sends `{ type: 'chunk', callId, data: T[] }` per chunk
7. Worker sends `{ type: 'done', callId, affected }` on completion
8. Client aggregates chunks, resolves Promise with result array
9. `releaseWorker()` processes queued requests (writers first)

## Data Flow — Worker Initialization

1. `createWorker()` creates `new Worker(url('./worker.ts', import.meta.url))`
2. Client sends `{ type: 'open', file, flags (SAB), index, vfs, pragmas }`
3. Worker acquires init lock via `Atomics.compareExchange` (serializes all workers)
4. Worker lazy-imports WASM module + VFS module
5. Worker registers VFS, opens database via `sqlite.open_v2(file)`
6. Worker releases init lock, sets status to READY, sends `{ type: 'ready', callId: 0 }`
7. Client resolves `deferredInit` promise, marks worker as `available: true`

## Concurrency Model
- **Read queries:** any available pool worker handles them (default pool size = 2)
- **Write queries:** a single dedicated writer worker handles writes serially
- **Writer designation:** the first worker to grab a write op becomes the current writer
- **Queuing:** separate `readerRequestQueue` and `writerRequestQueue` arrays for backpressure

## Key Abstractions
- `createSQLiteClient(file, options) → SQLiteDB` — factory function, public API
- `SQLiteDB` — interface: `read`, `write`, `stream`, `one` methods
- `WorkerOrchestrator` — class encapsulating SAB + Atomics operations
- `defer<T>()` — creates `{ promise, resolve, reject }` for deferred resolution
- `isWriteQuery(sql)` — regex heuristic: detects INSERT/REPLACE/UPDATE/DELETE/CREATE/DROP

## Entry Point
- `src/index.ts` re-exports everything from `src/client.ts`
- Public exports: `createSQLiteClient`, `CreateSQLLiteClientOptions`, `SQLiteDB`, `SQLiteVFS` types
