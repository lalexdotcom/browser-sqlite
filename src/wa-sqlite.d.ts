// Ambient declarations for wa-sqlite — covers ONLY the surface used in worker.ts.
// Typed minimally: opaque handles are `any`, row values are `unknown`.

/** Opaque database handle returned by sqlite.open_v2() */
type WASQLiteDB = any;

/** Opaque statement handle used in sqlite.statements() iteration */
type WASQLiteStmt = any;

/** The compiled WASM module instance passed to SQLite.Factory() */
type WASQLiteModule = {};

/** The SQLite API surface returned by SQLite.Factory(module) */
interface SQLiteAPI {
  open_v2(filename: string): Promise<WASQLiteDB>;
  statements(db: WASQLiteDB, sql: string): AsyncIterable<WASQLiteStmt>;
  bind_collection(stmt: WASQLiteStmt, params: unknown[]): void;
  column_names(stmt: WASQLiteStmt): string[];
  step(stmt: WASQLiteStmt): Promise<number>;
  row(stmt: WASQLiteStmt): unknown[];
  changes(db: WASQLiteDB): number;
  vfs_register(vfs: unknown, makeDefault?: boolean): void;
}

// ── sqlite-api.js ──────────────────────────────────────────────────────────
declare module 'wa-sqlite/src/sqlite-api.js' {
  export function Factory(module: WASQLiteModule): SQLiteAPI;
}

// ── sqlite-constants.js ────────────────────────────────────────────────────
declare module 'wa-sqlite/src/sqlite-constants.js' {
  export const SQLITE_ROW: number;
}

// ── WASM factory modules (.mjs) ────────────────────────────────────────────
// Each default export is a factory function that resolves to the WASM module.
declare module 'wa-sqlite/dist/wa-sqlite.mjs' {
  const factory: () => Promise<WASQLiteModule>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-async.mjs' {
  const factory: () => Promise<WASQLiteModule>;
  export default factory;
}

declare module 'wa-sqlite/dist/wa-sqlite-jspi.mjs' {
  const factory: () => Promise<WASQLiteModule>;
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
