/// <reference types="wa-sqlite" />
//
// Ambient declarations for wa-sqlite — ONLY what upstream does not ship.
//
// The reference above pulls in `wa-sqlite/src/types/index.d.ts`, which declares
// the global `SQLiteAPI`, `SQLiteVFS` and `SQLitePrepareOptions`, plus the
// modules `wa-sqlite`, `wa-sqlite/src/sqlite-constants.js`,
// `wa-sqlite/dist/wa-sqlite.mjs` and `-async.mjs`. Nothing here may redeclare
// any of those: ambient module blocks merge, and two `export default` for one
// module is a duplicate identifier.
//
// It does NOT pull in their `globals.d.ts` — no `/// <reference>` links the two
// — which is deliberate on our side too: that file declares `Module`, `HEAPU8`,
// `ccall` and forty Emscripten internals as untyped globals, and a typo would
// stop being an error the day it loaded.
//
// What upstream leaves out, and what is therefore below: `src/sqlite-api.js`
// (the module this library actually imports — upstream types the bare
// `wa-sqlite` entry point instead), the `jspi` build, and the nine VFS example
// classes, of which upstream declares only `examples/tag.js`.

/**
 * The compiled WASM module instance passed to SQLite.Factory().
 *
 * The database and statement handle aliases that used to sit here are gone:
 * they were `any`, they existed only to type the hand-written `SQLiteAPI` this
 * file no longer carries, and upstream types both as the `number` they are.
 */
type WASQLiteModule = {
  /**
   * `sqlite3_stmt_status`. Exported by all three builds; the JS façade does
   * not wrap it, and it takes a pointer and returns a number, so `mapStmtToDB`
   * — a JS-side guard only — is not involved. Declared here rather than cast
   * at the call site: the twelve structural `any` in `src/` stay twelve.
   */
  _sqlite3_stmt_status: (stmt: number, op: number, resetFlag: number) => number;
};

/**
 * Emscripten's module argument. Only `locateFile` is used, and only when the
 * consumer passed `wasmUrl` — its mere presence changes which branch
 * `findWasmBinary` takes, so it must stay optional here and be omitted rather
 * than defaulted. See `wasmModuleArg` in `src/worker/worker.ts`.
 *
 * Upstream types the factory argument as `config?: object`, which loses that.
 * Kept here and applied where the argument is BUILT, not where it is declared.
 */
type WASQLiteModuleArg = { locateFile?: (path: string) => string };

// ── sqlite-api.js — upstream declares the bare `wa-sqlite` entry, not this one ─
declare module 'wa-sqlite/src/sqlite-api.js' {
  export function Factory(module: WASQLiteModule): SQLiteAPI;
}

// ── the jspi build — upstream declares only the sync and async ones ──────────
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
