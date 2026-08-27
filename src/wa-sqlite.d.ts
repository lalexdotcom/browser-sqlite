// Ambient declarations for wa-sqlite — covers ONLY the surface used in worker.ts.
// Typed minimally: opaque handles are `any`, row values are `unknown`.

/** Opaque database handle returned by sqlite.open_v2() */
type WASQLiteDB = any;

/** Opaque statement handle used in sqlite.statements() iteration */
type WASQLiteStmt = any;

/** The compiled WASM module instance passed to SQLite.Factory() */
type WASQLiteModule = {};

/**
 * Emscripten's module argument. Only `locateFile` is used, and only when the
 * consumer passed `wasmUrl` — its mere presence changes which branch
 * `findWasmBinary` takes, so it must stay optional here and be omitted rather
 * than defaulted. See `wasmModuleArg` in `src/worker/worker.ts`.
 */
type WASQLiteModuleArg = { locateFile?: (path: string) => string };

/** Options passed to SQLiteAPI.statements() */
interface SQLitePrepareOptions {
  /** Keep statement handles alive after iteration (do not finalise on exit). */
  unscoped?: boolean;
  /** SQLITE_PREPARE_* flags, e.g. SQLITE_PREPARE_PERSISTENT. */
  flags?: number;
}

/** The SQLite API surface returned by SQLite.Factory(module) */
interface SQLiteAPI {
  open_v2(filename: string): Promise<WASQLiteDB>;
  statements(
    db: WASQLiteDB,
    sql: string,
    options?: SQLitePrepareOptions,
  ): AsyncIterable<WASQLiteStmt>;
  bind_collection(stmt: WASQLiteStmt, params: unknown[]): void;
  column_names(stmt: WASQLiteStmt): string[];
  step(stmt: WASQLiteStmt): Promise<number>;
  row(stmt: WASQLiteStmt): unknown[];
  /** Returns the SQL text of the statement (its own span of the input). */
  sql(stmt: WASQLiteStmt): string;
  /** Resets the statement; async and throws if the prior step returned an error. */
  reset(stmt: WASQLiteStmt): Promise<number>;
  /** Clears all bound parameter values; synchronous. */
  clear_bindings(stmt: WASQLiteStmt): void;
  /** Finalises (destroys) the statement; async. */
  finalize(stmt: WASQLiteStmt): Promise<void>;
  changes(db: WASQLiteDB): number;
  close(db: WASQLiteDB): Promise<number>;
  vfs_register(vfs: unknown, makeDefault?: boolean): void;
}

// ── sqlite-api.js ──────────────────────────────────────────────────────────
declare module 'wa-sqlite/src/sqlite-api.js' {
  export function Factory(module: WASQLiteModule): SQLiteAPI;
}

// ── sqlite-constants.js ────────────────────────────────────────────────────
declare module 'wa-sqlite/src/sqlite-constants.js' {
  export const SQLITE_ROW: number;
  export const SQLITE_PREPARE_PERSISTENT: number;
}

// ── WASM factory modules (.mjs) ────────────────────────────────────────────
// Each default export is a factory function that resolves to the WASM module.
declare module 'wa-sqlite/dist/wa-sqlite.mjs' {
  const factory: (moduleArg?: WASQLiteModuleArg) => Promise<WASQLiteModule>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-async.mjs' {
  const factory: (moduleArg?: WASQLiteModuleArg) => Promise<WASQLiteModule>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-jspi.mjs' {
  const factory: (moduleArg?: WASQLiteModuleArg) => Promise<WASQLiteModule>;
  export default factory;
}

// ── VFS example classes ────────────────────────────────────────────────────
// Each module exports a class with a static `create` factory method.
interface VFSClass {
  create(
    name: string,
    module: WASQLiteModule,
    options?: object,
  ): Promise<unknown>;
}

declare module 'wa-sqlite/src/examples/OPFSAdaptiveVFS.js' {
  export const OPFSAdaptiveVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/OPFSWriteAheadVFS.js' {
  export const OPFSWriteAheadVFS: VFSClass;
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

declare module 'wa-sqlite/src/examples/IDBMirrorVFS.js' {
  export const IDBMirrorVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/OPFSAnyContextVFS.js' {
  export const OPFSAnyContextVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/MemoryVFS.js' {
  export const MemoryVFS: VFSClass;
}

declare module 'wa-sqlite/src/examples/MemoryAsyncVFS.js' {
  export const MemoryAsyncVFS: VFSClass;
}
