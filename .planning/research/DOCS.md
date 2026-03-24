# Documentation Research: wsqlite

**Researched:** 2026-03-24
**Scope:** JSDoc for TypeScript libraries, README structure for browser libraries, ambient `.d.ts` for untyped WASM packages
**Confidence:** HIGH (based on direct source inspection of wa-sqlite, wsqlite source, and established TypeScript documentation conventions)

---

## 1. JSDoc for TypeScript Libraries

### What to Document — and What to Skip

In a TypeScript library, types are self-documenting for structure. JSDoc adds semantic meaning that types cannot express. Document:

- **Factory functions** — what the returned object represents, side effects (worker pool creation, SharedArrayBuffer allocation)
- **Method behaviour** — what SELECT vs INSERT routing decisions are made under the hood, not just return types
- **Options objects** — each field, its default, and what happens if omitted
- **Error conditions** — when does a method throw vs resolve to `undefined`
- **Concurrency semantics** — whether calls can be parallelised, what "exclusive write access" means practically
- **Streaming semantics** — when to prefer `stream()` over `read()`, memory implications
- **AbortSignal behaviour** — which methods honour it, what happens mid-stream on abort

Skip documenting things already clear from types: parameter names that match their types, obvious return types, internal helper functions not part of the public API.

### Documenting Factory Functions That Return Object APIs

The pattern in wsqlite is `createSQLiteClient(file, options)` returning a `SQLiteDB` with method properties. The JSDoc should describe the returned object as a whole, not just the factory parameters.

Recommended approach — describe initialization side effects prominently:

```typescript
/**
 * Creates a SQLite database client backed by a pool of Web Workers.
 *
 * Spawns `options.poolSize` workers immediately (default: 2). Each worker
 * loads the wa-sqlite WASM module and opens `file` via the configured VFS.
 * Workers finish initializing asynchronously — the returned client queues
 * requests and dispatches them once workers are ready.
 *
 * **Browser requirements:** `SharedArrayBuffer` is available only in
 * cross-origin isolated contexts. The page must be served with:
 * ```
 * Cross-Origin-Opener-Policy: same-origin
 * Cross-Origin-Embedder-Policy: require-corp
 * ```
 *
 * @param file - Database filename. For OPFS VFS backends this is the file
 *   name within the origin's OPFS root. For `IDBBatchAtomicVFS` it is the
 *   IndexedDB database name.
 * @param options - Configuration options. See {@link CreateSQLiteClientOptions}.
 * @returns A `SQLiteDB` API object. Call `db.close()` when done to terminate
 *   all workers and release resources.
 *
 * @throws {Error} If `vfs` is `'AccessHandlePoolVFS'` and `poolSize > 1`.
 *
 * @example
 * const db = createSQLiteClient('app.db', {
 *   vfs: 'OPFSPermutedVFS',
 *   poolSize: 3,
 *   pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL' },
 * });
 * const rows = await db.read('SELECT * FROM users WHERE active = ?', [1]);
 */
export const createSQLiteClient = (file: string, options?: CreateSQLiteClientOptions): SQLiteDB => { ... };
```

Key JSDoc tags for this pattern:

| Tag | Use |
|-----|-----|
| `@param name - description` | Describe each param; use sub-bullets for option fields |
| `@returns` | Describe what callers actually use on the returned object |
| `@throws` | Document synchronous throws (async rejections go in method docs) |
| `@example` | One real usage example; avoid toy examples |
| `{@link TypeName}` | Cross-reference to option types defined nearby |

### Documenting Options Types

Document the options type alongside the factory, not in isolation. Each field should state its default explicitly:

```typescript
/**
 * Configuration for {@link createSQLiteClient}.
 */
export type CreateSQLiteClientOptions = {
  /**
   * Display name for this client in logs and debug output.
   * Defaults to `'SQLite'`.
   */
  name?: string;

  /**
   * Number of worker threads in the pool.
   *
   * One worker handles all writes (serial). The remaining workers handle
   * concurrent reads. Default: `2`.
   *
   * Must be `1` when `vfs` is `'AccessHandlePoolVFS'`.
   */
  poolSize?: number;

  /**
   * Virtual File System backend for database persistence.
   *
   * - `'OPFSPermutedVFS'` — OPFS, async WASM, multi-reader. **Recommended default.**
   * - `'OPFSCoopSyncVFS'` — OPFS, sync WASM, compatible with more browsers.
   * - `'OPFSAdaptiveVFS'` — OPFS, JSPI WASM. Chrome-only (experimental).
   * - `'AccessHandlePoolVFS'` — OPFS, sync WASM. Single-worker only.
   * - `'IDBBatchAtomicVFS'` — IndexedDB, no OPFS required.
   *
   * Defaults to `'OPFSPermutedVFS'`.
   */
  vfs?: SQLiteVFS;

  /**
   * SQLite PRAGMAs applied when each worker opens the database.
   * Keys are pragma names, values are pragma values (as strings).
   *
   * @example
   * pragmas: { journal_mode: 'WAL', synchronous: 'NORMAL', cache_size: '-8000' }
   */
  pragmas?: Record<string, string>;

  /**
   * Enable debug state tracking. Attaches a `debug` property to the
   * returned client with per-worker request history and timing data.
   * Has a small runtime cost — disable in production.
   */
  debug?: boolean;
};
```

### Documenting the `SQLiteDB` Type (Interface for an Object)

`SQLiteDB` is a type not a class, so JSDoc lives on the type and on each method signature. Because wsqlite uses a type alias with method properties (not a class with methods), the recommended approach is to document the type body directly:

```typescript
/**
 * Database query API returned by {@link createSQLiteClient}.
 *
 * All methods are safe to call concurrently. Write queries are serialised
 * internally — concurrent `write()` calls queue behind each other.
 * Read queries run in parallel up to `poolSize - 1` concurrent workers.
 */
export type SQLiteDB = {
  /**
   * Executes a read query and collects all rows into memory.
   *
   * Routes the query to a reader worker. If the SQL is detected as a write
   * statement (INSERT, UPDATE, DELETE, CREATE, DROP, REPLACE), it is
   * silently routed to the write worker instead.
   *
   * @param sql - SQL statement. Use `?` placeholders for parameters.
   * @param params - Bound values for `?` placeholders.
   * @param options - Query options.
   * @returns All result rows as plain objects keyed by column name.
   *
   * @example
   * const users = await db.read<{ id: number; name: string }>(
   *   'SELECT id, name FROM users WHERE active = ?',
   *   [1],
   * );
   */
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<T[]>;

  /**
   * Executes a write query (INSERT, UPDATE, DELETE, etc.) on the dedicated
   * write worker.
   *
   * Write calls are serialised — concurrent `write()` calls queue and
   * execute one at a time on the same worker, maintaining consistency.
   *
   * @param sql - SQL statement.
   * @param params - Bound values for `?` placeholders.
   * @param options - Query options.
   * @returns `result`: any rows returned by the query (e.g. `RETURNING`
   *   clauses); `affected`: rows changed by the statement.
   *
   * @example
   * const { affected } = await db.write(
   *   'INSERT INTO events (name, ts) VALUES (?, ?)',
   *   ['click', Date.now()],
   * );
   */
  write: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteQueryOptions<T>,
  ) => Promise<{ result: T[]; affected: number }>;

  /**
   * Executes a query and yields rows in chunks as an async generator.
   *
   * Use `stream()` for large result sets to avoid loading all rows into
   * memory at once. Each yielded chunk is an array of up to `chunkSize`
   * rows (default 500).
   *
   * Supports cancellation via `AbortSignal`. Aborting mid-stream causes
   * the worker to stop fetching rows; already-yielded chunks are not
   * revoked.
   *
   * The worker is held for the lifetime of the generator. Always consume
   * or explicitly return the generator to release the worker back to the pool.
   *
   * @param sql - SQL statement.
   * @param params - Bound values for `?` placeholders.
   * @param options - Query options including `signal` and `chunkSize`.
   * @yields Arrays of result rows, each array up to `chunkSize` length.
   *
   * @example
   * const ac = new AbortController();
   * for await (const chunk of db.stream('SELECT * FROM logs', [], { signal: ac.signal })) {
   *   processChunk(chunk);
   *   if (done) ac.abort();
   * }
   */
  stream: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: SQLiteStreamOptions<T>,
  ) => AsyncGenerator<T[]>;

  /**
   * Executes a query and returns the first row, or `undefined` if no rows match.
   *
   * Internally uses `stream()` with `chunkSize: 1` and aborts after the
   * first chunk — the query is cancelled server-side after the first row
   * is received. This makes `one()` efficient for existence checks.
   *
   * @param sql - SQL statement.
   * @param params - Bound values for `?` placeholders.
   * @param options - Query options (note: `chunkSize` and `signal` are not
   *   accepted here — they are managed internally).
   * @returns The first row as a plain object, or `undefined`.
   *
   * @example
   * const user = await db.one<{ name: string }>(
   *   'SELECT name FROM users WHERE id = ?', [42]
   * );
   */
  one: <T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
    options?: Omit<SQLiteQueryOptions<T>, 'chunkSize' | 'signal'>,
  ) => Promise<T | undefined>;
};
```

### Documenting Async Generator Methods

The `stream()` method is an `AsyncGenerator`. Key documentation points that types don't express:

1. **Use `@yields` not `@returns`** — technically both work in tools like TypeDoc/TSDoc, but `@yields` is semantically correct and shows up properly in IDE hover.
2. **Resource lifecycle** — a generator holds a worker. The doc must warn that the generator must be consumed or returned.
3. **Abort semantics** — what happens mid-stream.
4. **Chunk size relationship to memory** — why chunking exists.

For IDEs (VSCode), `@yields` is supported in JSDoc hover. TypeDoc renders it as a dedicated section.

Pattern for generator return type annotation — always annotate explicitly rather than relying on inference, because TypeScript infers `AsyncGenerator<T[], void, unknown>` and inference can change:

```typescript
// Explicit annotation prevents type inference drift:
stream: (...) => AsyncGenerator<T[]>;
// Not: stream: (...) => AsyncGenerator<T[], void, unknown>
// The extra type params are noise in docs when they're always void/unknown
```

### Documenting Query Options

The `SQLiteQueryOptions` type is used across all methods. Document it once and reference it:

```typescript
/**
 * Options for query execution methods.
 */
type SQLiteQueryOptions<T extends Record<string, unknown>> = {
  /**
   * Number of rows to buffer per chunk before yielding.
   * Lower values reduce memory pressure; higher values reduce overhead.
   * Default: `500`. Only meaningful for `stream()`.
   */
  chunkSize?: number;

  /**
   * Abort signal to cancel a running query. When the signal fires, the
   * worker stops fetching rows and the generator/promise settles.
   * The connection is returned to the pool after abort completes.
   */
  signal?: AbortSignal;

  /**
   * Optional identifier for this query in debug output.
   */
  id?: string;
};
```

### JSDoc Tags Reference for this API

| Tag | When to Use |
|-----|-------------|
| `@param name - desc` | Every public parameter |
| `@returns desc` | When return value needs explanation beyond type |
| `@yields desc` | For generator methods |
| `@throws {ErrorType} desc` | For synchronous throws; async rejections go in `@returns` |
| `@example` | One focused example per method; use triple-backtick code blocks |
| `{@link Name}` | Cross-reference to related types/functions |
| `@deprecated desc` | When a method is being phased out |
| `@internal` | Marks types/functions not part of public contract (TSDoc standard) |
| `@defaultValue val` | For option fields with defaults (TSDoc; renders in TypeDoc) |

**Avoid:** `@type`, `@typedef`, `@class` — these are for untyped JS. In TypeScript source, types speak for themselves.

---

## 2. README Structure for Browser TypeScript Libraries

### Sections That Matter for Consumers

A consumer arriving at wsqlite's README needs to know: does this work for my browser setup, how do I install it, how do I use it in 5 minutes, and what VFS should I choose. That determines the structure.

**Recommended section order:**

```
1. One-line description + badge row (browser compat, npm version, license)
2. What it is / why use it (3-4 sentences max, not marketing)
3. Browser Requirements (COOP/COEP headers — upfront, saves people debugging)
4. Installation
5. Quick Start (one working example, no options)
6. VFS Selection Guide (the hardest decision, needs its own section)
7. API Reference (link to generated docs or inline)
8. Configuration Reference (options object)
9. Recipes (streaming, abort, transactions, bulkWrite, output)
10. Limitations / Out of Scope
11. License
```

### Section: Browser Requirements (Must Be First)

This is the most common gotcha. If `SharedArrayBuffer` is not available, nothing works — and the error is confusing (`SharedArrayBuffer is not defined`). Put it before Installation.

```markdown
## Browser Requirements

wsqlite uses `SharedArrayBuffer` for cross-thread synchronization, which
requires a **cross-origin isolated** page. Your server must send:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these headers, `createSQLiteClient()` will throw at runtime.

**OPFS VFS backends** additionally require Chrome 102+ / Edge 102+ / Firefox 111+.
Safari has partial OPFS support (no `FileSystemSyncAccessHandle` in workers) —
use `IDBBatchAtomicVFS` for Safari compatibility.

**JSPI (OPFSAdaptiveVFS)** is Chrome-only and behind a flag — avoid in production.
```

### Section: VFS Selection Guide

VFS choice is the most consequential option and has no obvious default. It needs a dedicated section, not a buried table in the API reference.

```markdown
## VFS Selection Guide

| VFS | Persistence | Multi-reader | Browser Support | Notes |
|-----|-------------|--------------|-----------------|-------|
| `OPFSPermutedVFS` | OPFS file | Yes | Chrome 102+, Firefox 111+ | Recommended default |
| `OPFSCoopSyncVFS` | OPFS file | Yes | Chrome 102+, Firefox 111+ | Sync WASM, lower perf |
| `OPFSAdaptiveVFS` | OPFS file | Yes | Chrome only (JSPI flag) | Experimental |
| `AccessHandlePoolVFS` | OPFS file | No (poolSize must be 1) | Chrome 102+, Firefox 111+ | Single-writer only |
| `IDBBatchAtomicVFS` | IndexedDB | Yes | All modern browsers | Safari-compatible |

**Choose `OPFSPermutedVFS`** unless you need Safari support.
**Choose `IDBBatchAtomicVFS`** for maximum browser compatibility.
**Avoid `OPFSAdaptiveVFS`** in production — JSPI is not stable.
```

### Section: Quick Start

Show the minimal working case with zero configuration. Then show the realistic case with options. Do not explain everything in the Quick Start.

```markdown
## Quick Start

```typescript
import { createSQLiteClient } from 'wsqlite';

const db = createSQLiteClient('myapp.db');

// Write
await db.write('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)');
await db.write('INSERT INTO notes (text) VALUES (?)', ['Hello, SQLite!']);

// Read
const notes = await db.read<{ id: number; text: string }>('SELECT * FROM notes');

// Single row
const note = await db.one<{ text: string }>('SELECT text FROM notes WHERE id = ?', [1]);

// Stream large results
for await (const chunk of db.stream('SELECT * FROM notes')) {
  console.log(chunk); // chunk is Note[]
}

// Clean up
db.close();
```

### Limitations Section

Be explicit about what the library does NOT do, so people don't file issues:

```markdown
## Limitations

- **Browser only** — no Node.js support. Web Workers and OPFS are browser APIs.
- **No transaction API exposed** in the current version — use `db.write()` with
  explicit `BEGIN`/`COMMIT` SQL if needed.
- **No schema migration tooling** — bring your own migration strategy.
- **No query builder** — raw SQL only.
- **Concurrency model is fixed** — 1 writer, N-1 readers. Not configurable beyond pool size.
```

### Installation Section

Be explicit about the GitHub source install (not npm), since wa-sqlite is a dependency:

```markdown
## Installation

```bash
npm install wsqlite
# or
pnpm add wsqlite
```

> **Note:** wsqlite depends on
> [`wa-sqlite`](https://github.com/rhashimoto/wa-sqlite), installed directly
> from GitHub. Your bundler must support WASM and dynamic imports. Tested with
> webpack 5 and Rspack/Rslib.
```

### Badges

For a browser TypeScript library, useful badges:
- Browser compatibility (manually maintained or via Can I Use shield)
- npm version
- License
- TypeScript (to signal this is typed)
- Bundle size (bundlephobia link)

Skip CI/coverage badges until those pipelines exist.

---

## 3. Ambient Declarations for wa-sqlite

### Why Manual Ambient Declarations

wa-sqlite ships no TypeScript declarations. The current codebase uses `@ts-expect-error` on every import from `wa-sqlite/*`. This approach has two problems:

1. `@ts-expect-error` suppresses ALL type errors on the next line, not just the missing declaration error — a genuine type mistake on the same line is silently ignored.
2. All values imported from wa-sqlite become `any`, meaning `sqlite.open_v2(file)` returns `any` and calls like `sqlite.bind_collection(stmt, params)` accept any argument silently.

A `wa-sqlite.d.ts` ambient declaration file restores type safety without changing the runtime.

### File Location

The declaration must be placed where TypeScript can find it via `typeRoots` or the `include` path. The correct location for this project:

```
src/types/wa-sqlite.d.ts
```

Or, for a module augmentation approach:

```
src/wa-sqlite.d.ts
```

Since `tsconfig.json` includes `["src"]`, any `.d.ts` in `src/` is picked up automatically.

### Declaration Structure

wa-sqlite has two import paths used in `worker.ts`:

```typescript
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
```

And three WASM module paths (async dynamic imports):

```typescript
import 'wa-sqlite/dist/wa-sqlite.mjs'
import 'wa-sqlite/dist/wa-sqlite-async.mjs'
import 'wa-sqlite/dist/wa-sqlite-jspi.mjs'
```

And VFS class paths (async dynamic imports):

```typescript
import 'wa-sqlite/src/examples/OPFSPermutedVFS.js'
// etc.
```

Each distinct import path needs its own `declare module` block.

### The SQLiteAPI Type

The most important type is `SQLiteAPI` — the object returned by `Factory(module)`. From reading `sqlite-api.js` directly:

```typescript
// Opaque handles — SQLite uses C pointers as numbers
type SQLiteDatabase = number;   // sqlite3* handle
type SQLiteStatement = number;  // sqlite3_stmt* handle
type SQLiteContext = number;    // sqlite3_context* handle
type SQLiteValue = number;      // sqlite3_value* handle

// Column values can be numbers, strings, bigints, blobs, or null
type SQLiteColumnValue = number | string | bigint | Uint8Array | null;

// Binding values (what you can pass to bind_collection)
type SQLiteBindValue = number | string | bigint | boolean | Uint8Array | null | undefined;

interface SQLiteAPI {
  // Core database lifecycle
  open_v2(filename: string, flags?: number, vfs?: string): Promise<SQLiteDatabase>;
  close(db: SQLiteDatabase): Promise<number>;

  // Statement execution
  statements(db: SQLiteDatabase, sql: string, options?: { flags?: number; unscoped?: boolean }): AsyncIterable<SQLiteStatement>;
  step(stmt: SQLiteStatement): Promise<number>; // returns SQLITE_ROW | SQLITE_DONE
  finalize(stmt: SQLiteStatement): Promise<number>;
  reset(stmt: SQLiteStatement): Promise<number>;

  // Parameter binding
  bind(stmt: SQLiteStatement, i: number, value: SQLiteBindValue): number;
  bind_collection(stmt: SQLiteStatement, bindings: SQLiteBindValue[] | Record<string, SQLiteBindValue>): number;
  bind_blob(stmt: SQLiteStatement, i: number, value: Uint8Array | number[]): number;
  bind_double(stmt: SQLiteStatement, i: number, value: number): number;
  bind_int(stmt: SQLiteStatement, i: number, value: number): number;
  bind_int64(stmt: SQLiteStatement, i: number, value: bigint): number;
  bind_null(stmt: SQLiteStatement, i: number): number;
  bind_text(stmt: SQLiteStatement, i: number, value: string): number;
  bind_parameter_count(stmt: SQLiteStatement): number;
  bind_parameter_name(stmt: SQLiteStatement, i: number): string;
  clear_bindings(stmt: SQLiteStatement): number;

  // Column access
  column(stmt: SQLiteStatement, iCol: number): SQLiteColumnValue;
  column_blob(stmt: SQLiteStatement, iCol: number): Uint8Array;
  column_bytes(stmt: SQLiteStatement, iCol: number): number;
  column_count(stmt: SQLiteStatement): number;
  column_double(stmt: SQLiteStatement, iCol: number): number;
  column_int(stmt: SQLiteStatement, iCol: number): number;
  column_int64(stmt: SQLiteStatement, iCol: number): bigint;
  column_name(stmt: SQLiteStatement, iCol: number): string;
  column_names(stmt: SQLiteStatement): string[];
  column_text(stmt: SQLiteStatement, iCol: number): string;
  column_type(stmt: SQLiteStatement, iCol: number): number;

  // Row access (returns column values as array)
  row(stmt: SQLiteStatement): SQLiteColumnValue[];
  data_count(stmt: SQLiteStatement): number;

  // Aggregate info
  changes(db: SQLiteDatabase): number;
  get_autocommit(db: SQLiteDatabase): number;

  // Metadata
  libversion(): string;
  libversion_number(): number;
  sql(stmt: SQLiteStatement): string;
  limit(db: SQLiteDatabase, id: number, newVal: number): number;

  // Execute with optional row callback
  exec(db: SQLiteDatabase, sql: string, callback?: (row: SQLiteColumnValue[], columns: string[]) => void | Promise<void>): Promise<number>;

  // Custom SQL functions
  create_function(
    db: SQLiteDatabase,
    name: string,
    nArg: number,
    eTextRep: number,
    pApp: number,
    xFunc?: (ctx: SQLiteContext, values: Int32Array) => void | Promise<void>,
    xStep?: (ctx: SQLiteContext, values: Int32Array) => void | Promise<void>,
    xFinal?: (ctx: SQLiteContext) => void | Promise<void>,
  ): number;

  // Scalar result setters (used in create_function callbacks)
  result(context: SQLiteContext, value: SQLiteBindValue): void;
  result_blob(context: SQLiteContext, value: Uint8Array | number[]): void;
  result_double(context: SQLiteContext, value: number): void;
  result_int(context: SQLiteContext, value: number): void;
  result_int64(context: SQLiteContext, value: bigint): void;
  result_null(context: SQLiteContext): void;
  result_text(context: SQLiteContext, value: string): void;

  // Value getters (used in create_function callbacks)
  value(pValue: SQLiteValue): SQLiteColumnValue;
  value_blob(pValue: SQLiteValue): Uint8Array;
  value_bytes(pValue: SQLiteValue): number;
  value_double(pValue: SQLiteValue): number;
  value_int(pValue: SQLiteValue): number;
  value_int64(pValue: SQLiteValue): bigint;
  value_text(pValue: SQLiteValue): string;
  value_type(pValue: SQLiteValue): number;

  // Hooks
  commit_hook(db: SQLiteDatabase, callback: (() => number) | null): void;
  update_hook(db: SQLiteDatabase, callback: ((updateType: number, dbName: string, tblName: string, rowId: bigint) => void) | null): void;
  set_authorizer(db: SQLiteDatabase, xAuth: (pApp: number, iAction: number, p3: string, p4: string, p5: string, p6: string) => number, pApp?: number): number;
  progress_handler(db: SQLiteDatabase, nProgressOps: number, handler: (() => number) | null, userData?: number): void;

  // VFS
  vfs_register(vfs: object, makeDefault?: boolean): number;
}
```

### The SQLiteError Class

wa-sqlite throws `SQLiteError` (not plain `Error`). It has a `code` property:

```typescript
declare class SQLiteError extends Error {
  readonly code: number;
  constructor(message: string, code: number);
}
```

### The Factory Function and Module Type

The WASM modules (`.mjs` files) use Emscripten's default export pattern:

```typescript
// The Emscripten module returned by the factory
interface WASQLiteModule {
  // Emscripten memory access
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  getTempRet0(): number;
  _malloc(size: number): number;
  _sqlite3_malloc(size: number): number;
  _sqlite3_free(ptr: number): void;
  cwrap(name: string, returnType: string | null, argTypes: string[], opts?: { async?: boolean }): (...args: any[]) => any;
  ccall(name: string, returnType: string, argTypes: string[], args: any[]): any;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
  UTF8ToString(ptr: number): string;
  // Internal use by sqlite-api.js
  retryOps: Promise<unknown>[];
  vfs_register(vfs: object, makeDefault?: boolean): number;
  create_function(...args: any[]): number;
  commit_hook(db: number, cb: (() => number) | null): void;
  update_hook(db: number, cb: ((...args: any[]) => void) | null): void;
  set_authorizer(db: number, cb: ((...args: any[]) => number), pApp?: number): number;
  progress_handler(db: number, nOps: number, cb: (() => number) | null, userData?: number): void;
}
```

### Complete Ambient Declaration File

The full `declare module` blocks:

```typescript
// src/types/wa-sqlite.d.ts

declare module 'wa-sqlite/src/sqlite-constants.js' {
  // Primary result codes
  export const SQLITE_OK: 0;
  export const SQLITE_ERROR: 1;
  export const SQLITE_BUSY: 5;
  export const SQLITE_LOCKED: 6;
  export const SQLITE_READONLY: 8;
  export const SQLITE_IOERR: 10;
  export const SQLITE_CORRUPT: 11;
  export const SQLITE_FULL: 13;
  export const SQLITE_CANTOPEN: 14;
  export const SQLITE_CONSTRAINT: 19;
  export const SQLITE_MISUSE: 21;
  export const SQLITE_AUTH: 23;
  export const SQLITE_RANGE: 25;
  export const SQLITE_NOTICE: 27;
  export const SQLITE_ROW: 100;
  export const SQLITE_DONE: 101;

  // Column types
  export const SQLITE_INTEGER: 1;
  export const SQLITE_FLOAT: 2;
  export const SQLITE_TEXT: 3;
  export const SQLITE_BLOB: 4;
  export const SQLITE_NULL: 5;

  // Open flags
  export const SQLITE_OPEN_READONLY: number;
  export const SQLITE_OPEN_READWRITE: number;
  export const SQLITE_OPEN_CREATE: number;
  export const SQLITE_OPEN_URI: number;
  export const SQLITE_OPEN_MEMORY: number;
  export const SQLITE_OPEN_NOMUTEX: number;
  export const SQLITE_OPEN_FULLMUTEX: number;
  export const SQLITE_OPEN_SHAREDCACHE: number;
  export const SQLITE_OPEN_PRIVATECACHE: number;
}

declare module 'wa-sqlite/src/sqlite-api.js' {
  export { SQLiteError, Factory, SQLiteAPI };
  export * from 'wa-sqlite/src/sqlite-constants.js';

  export class SQLiteError extends Error {
    readonly code: number;
    constructor(message: string, code: number);
  }

  // Opaque handle types (C pointers represented as numbers)
  type SQLiteDatabase = number;
  type SQLiteStatement = number;
  type SQLiteContext = number;
  type SQLiteValue = number;
  type SQLiteColumnValue = number | string | bigint | Uint8Array | null;
  type SQLiteBindValue = number | string | bigint | boolean | Uint8Array | null | undefined;

  interface SQLiteAPI {
    open_v2(filename: string, flags?: number, vfs?: string): Promise<SQLiteDatabase>;
    close(db: SQLiteDatabase): Promise<number>;
    exec(db: SQLiteDatabase, sql: string, callback?: (row: SQLiteColumnValue[], columns: string[]) => void | Promise<void>): Promise<number>;
    statements(db: SQLiteDatabase, sql: string, options?: { flags?: number; unscoped?: boolean }): AsyncIterable<SQLiteStatement>;
    step(stmt: SQLiteStatement): Promise<number>;
    finalize(stmt: SQLiteStatement): Promise<number>;
    reset(stmt: SQLiteStatement): Promise<number>;
    changes(db: SQLiteDatabase): number;
    get_autocommit(db: SQLiteDatabase): number;
    libversion(): string;
    libversion_number(): number;
    limit(db: SQLiteDatabase, id: number, newVal: number): number;
    sql(stmt: SQLiteStatement): string;
    bind(stmt: SQLiteStatement, i: number, value: SQLiteBindValue): number;
    bind_collection(stmt: SQLiteStatement, bindings: SQLiteBindValue[] | Record<string, SQLiteBindValue>): number;
    bind_blob(stmt: SQLiteStatement, i: number, value: Uint8Array | number[]): number;
    bind_double(stmt: SQLiteStatement, i: number, value: number): number;
    bind_int(stmt: SQLiteStatement, i: number, value: number): number;
    bind_int64(stmt: SQLiteStatement, i: number, value: bigint): number;
    bind_null(stmt: SQLiteStatement, i: number): number;
    bind_text(stmt: SQLiteStatement, i: number, value: string): number;
    bind_parameter_count(stmt: SQLiteStatement): number;
    bind_parameter_name(stmt: SQLiteStatement, i: number): string;
    clear_bindings(stmt: SQLiteStatement): number;
    column(stmt: SQLiteStatement, iCol: number): SQLiteColumnValue;
    column_blob(stmt: SQLiteStatement, iCol: number): Uint8Array;
    column_bytes(stmt: SQLiteStatement, iCol: number): number;
    column_count(stmt: SQLiteStatement): number;
    column_double(stmt: SQLiteStatement, iCol: number): number;
    column_int(stmt: SQLiteStatement, iCol: number): number;
    column_int64(stmt: SQLiteStatement, iCol: number): bigint;
    column_name(stmt: SQLiteStatement, iCol: number): string;
    column_names(stmt: SQLiteStatement): string[];
    column_text(stmt: SQLiteStatement, iCol: number): string;
    column_type(stmt: SQLiteStatement, iCol: number): number;
    row(stmt: SQLiteStatement): SQLiteColumnValue[];
    data_count(stmt: SQLiteStatement): number;
    create_function(db: SQLiteDatabase, name: string, nArg: number, eTextRep: number, pApp: number, xFunc?: (ctx: SQLiteContext, values: Int32Array) => void | Promise<void>, xStep?: (ctx: SQLiteContext, values: Int32Array) => void | Promise<void>, xFinal?: (ctx: SQLiteContext) => void | Promise<void>): number;
    result(context: SQLiteContext, value: SQLiteBindValue): void;
    result_blob(context: SQLiteContext, value: Uint8Array | number[]): void;
    result_double(context: SQLiteContext, value: number): void;
    result_int(context: SQLiteContext, value: number): void;
    result_int64(context: SQLiteContext, value: bigint): void;
    result_null(context: SQLiteContext): void;
    result_text(context: SQLiteContext, value: string): void;
    value(pValue: SQLiteValue): SQLiteColumnValue;
    value_blob(pValue: SQLiteValue): Uint8Array;
    value_bytes(pValue: SQLiteValue): number;
    value_double(pValue: SQLiteValue): number;
    value_int(pValue: SQLiteValue): number;
    value_int64(pValue: SQLiteValue): bigint;
    value_text(pValue: SQLiteValue): string;
    value_type(pValue: SQLiteValue): number;
    commit_hook(db: SQLiteDatabase, callback: (() => number) | null): void;
    update_hook(db: SQLiteDatabase, callback: ((updateType: number, dbName: string, tblName: string, rowId: bigint) => void) | null): void;
    set_authorizer(db: SQLiteDatabase, xAuth: (pApp: number, iAction: number, p3: string, p4: string, p5: string, p6: string) => number, pApp?: number): number;
    progress_handler(db: SQLiteDatabase, nProgressOps: number, handler: (() => number) | null, userData?: number): void;
    vfs_register(vfs: object, makeDefault?: boolean): number;
  }

  export function Factory(module: object): SQLiteAPI;
}

// WASM module dynamic imports — each returns a factory function
declare module 'wa-sqlite/dist/wa-sqlite.mjs' {
  const factory: () => Promise<object>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-async.mjs' {
  const factory: () => Promise<object>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-jspi.mjs' {
  const factory: () => Promise<object>;
  export default factory;
}

// VFS class modules — each exports a class with a static create() method
interface VFSClass {
  create(name: string, module: object, options?: Record<string, unknown>): Promise<object>;
}

declare module 'wa-sqlite/src/examples/OPFSPermutedVFS.js' {
  export const OPFSPermutedVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/OPFSAdaptiveVFS.js' {
  export const OPFSAdaptiveVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js' {
  export const OPFSCoopSyncVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/AccessHandlePoolVFS.js' {
  export const AccessHandlePoolVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js' {
  export const IDBBatchAtomicVFS: VFSClass;
}
```

### Authoring Notes for Ambient Declarations

**Use opaque number types for C handles.** SQLite database handles and statement handles are C pointers — they're numbers at runtime but should not be interchangeable. TypeScript doesn't have nominal types natively, but you can approximate with branded types if strictness is needed:

```typescript
// Option A: simple (what the declaration above uses)
type SQLiteDatabase = number;

// Option B: branded (prevents accidental swap of db and stmt args)
type SQLiteDatabase = number & { readonly __brand: 'SQLiteDatabase' };
type SQLiteStatement = number & { readonly __brand: 'SQLiteStatement' };
```

Option B is safer but requires explicit casts in `sqlite-api.js` call sites. Since this library wraps wa-sqlite and doesn't expose handles to consumers, Option A is sufficient.

**The `statements()` return type is `AsyncIterable`, not `AsyncGenerator`.** The source uses `(async function*() { ... })()` which returns `AsyncGenerator`, but the public contract only requires iteration — `AsyncIterable<SQLiteStatement>` is the correct minimal type.

**`Factory` returns `SQLiteAPI`, not the module.** The WASM module is the argument; `SQLiteAPI` is the return:

```typescript
// In worker.ts:
const sqlite = SQLite.Factory(module); // sqlite: SQLiteAPI
```

**`@ts-expect-error` placement after declarations.** Once declarations are in place, the `@ts-expect-error` directives on import lines in `worker.ts` become errors themselves (TypeScript will complain "this directive is unnecessary"). They must be removed, not left in place.

**VFS module shape.** From inspecting `OPFSPermutedVFS.js`, VFS classes use a static `create(name, module, options)` factory. The naming convention in the VFS configs is that the import is `vfsModule[vfs]` where `vfs` is the VFS name string. The exported name matches the class name matches the VFS name string:

```typescript
// This is how worker.ts uses it:
const vfsModule = await vfsConfig.fs();
const VFSClass = vfsModule[vfs]; // e.g. vfsModule['OPFSPermutedVFS']
const vfsInstance = await VFSClass.create(vfs, module, { lockPolicy: 'shared' });
```

So `VFSClass` in the declaration must match the exported name. The declaration is correct: `export const OPFSPermutedVFS: VFSClass`.

---

## 4. Issues Found in Current Code Relevant to Docs

These are documentation-adjacent bugs observed during source reading:

### The `satisfies` Constraint on `createSQLiteClient` is Wrong

```typescript
// client.ts line 775
}) satisfies (...args: any[]) => SQLiteDB;
```

The actual return type of the implementation includes `transaction`, `bulkWrite`, `output`, `close`, and `debug` — none of which are on `SQLiteDB`. This means the `satisfies` check silently drops them from the documented type. The exported `SQLiteDB` type should be updated to include these methods, or the return type annotation should use a separate wider type.

### `CreateSQLLiteClientOptions` has a typo

The type is named `CreateSQLLiteClientOptions` (double L in SQLLite). This is the name that consumers see if they import the type. The README and JSDoc should use the correct spelling, and the type name should be fixed in a rename refactor.

### The Pragma Bug Affects Documentation

From `worker.ts`:

```typescript
const allQueryPragmas = Object.keys(pragmas).length
  ? ''                                              // bug: inverted condition
  : Object.entries(pragmas)
      .map(([key, val]) => `PRAGMA ${key}=${val};`)
      .join('');
```

This means `pragmas` are **never applied** currently. The JSDoc for `pragmas` should not claim they work until this is fixed. Note this in the options documentation with a `@remarks` or inline note.

---

## 5. Confidence Assessment

| Area | Confidence | Basis |
|------|------------|-------|
| JSDoc patterns | HIGH | Direct source inspection + established TypeScript JSDoc conventions |
| README structure | HIGH | Based on browser library patterns; browser-requirement placement is standard |
| wa-sqlite API surface | HIGH | Read entire `sqlite-api.js` source; all methods catalogued |
| VFS module shape | HIGH | Inspected `OPFSPermutedVFS.js` and `VFS.js` base class |
| WASM module factory shape | HIGH | Inferred from usage in `worker.ts` + Emscripten module conventions |
| `@yields` IDE support | MEDIUM | Well-established in TypeDoc; VSCode support verified by convention |
| Branded number types | MEDIUM | TypeScript pattern, not wa-sqlite specific |
