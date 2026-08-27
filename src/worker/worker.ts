/**
 * SQLite Web Worker entry point.
 *
 * Each worker in the pool runs this module. It handles two message types:
 * - `open` — loads the wa-sqlite WASM module, opens the database, and transitions to READY
 * - `query` — executes a SQL statement and streams results back as chunks
 *
 * Lifecycle labels (`NEW`, `READY`, `RUNNING`, `ABORTING`, `CLOSED`, `DEAD`) are
 * maintained by `src/pool.ts`, not by this module. From this worker's perspective:
 * the database open is serialised by `navigator.locks` (`initLockName(file)`);
 * readiness is reported via the `ready` message; an abort arrives as a `stop`
 * message and is observed through the credit gate's stopped flag.
 */
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
import {
  createCreditGate,
  createMessageChannelTick,
  DEFAULT_CREDIT_WINDOW,
} from '../credits';
import { createLocks, initLockName } from '../locks';
import {
  type ClientMessageData,
  defaultBuildFor,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type WasmLocation,
  type WorkerMessageData,
} from '../types';
import { renderPragmas } from '../utils';

type SQLOptions = { chunkSize?: number; signal?: AbortSignal };

const WA_SQLITE_BUILDS = {
  sync: () =>
    import(/* webpackChunkName: "wa-sqlite" */ 'wa-sqlite/dist/wa-sqlite.mjs'),
  async: () =>
    import(
      /* webpackChunkName: "wa-sqlite-async" */ 'wa-sqlite/dist/wa-sqlite-async.mjs'
    ),
  jspi: () =>
    import(
      /* webpackChunkName: "wa-sqlite-jspi" */ 'wa-sqlite/dist/wa-sqlite-jspi.mjs'
    ),
} as const satisfies Record<SQLiteBuild, () => Promise<any>>;

/**
 * VFS loaders only. Which build each VFS may run on lives in `VFS_CAPABILITIES`
 * (`src/types.ts`) and nowhere else — the client validates against it and sends
 * the chosen build in the `open` message, so there is no second copy to drift.
 */
const VFSConfigs = {
  OPFSAdaptiveVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSAdaptiveVFS" */ 'wa-sqlite/src/examples/OPFSAdaptiveVFS.js'
      ),
  },
  OPFSWriteAheadVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSWriteAheadVFS" */ 'wa-sqlite/src/examples/OPFSWriteAheadVFS.js'
      ),
  },
  OPFSCoopSyncVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSCoopSyncVFS" */ 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js'
      ),
  },
  AccessHandlePoolVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "AccessHandlePoolVFS" */ 'wa-sqlite/src/examples/AccessHandlePoolVFS.js'
      ),
  },
  IDBBatchAtomicVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "IDBBatchAtomicVFS" */ 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js'
      ),
  },
  IDBMirrorVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "IDBMirrorVFS" */ 'wa-sqlite/src/examples/IDBMirrorVFS.js'
      ),
  },
  OPFSAnyContextVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSAnyContextVFS" */ 'wa-sqlite/src/examples/OPFSAnyContextVFS.js'
      ),
  },
  MemoryVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "MemoryVFS" */ 'wa-sqlite/src/examples/MemoryVFS.js'
      ),
  },
  MemoryAsyncVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "MemoryAsyncVFS" */ 'wa-sqlite/src/examples/MemoryAsyncVFS.js'
      ),
  },
} as const satisfies Record<SQLiteVFS, { fs: () => Promise<any> }>;

let openedDB: Promise<{ sqlite: any; db: any }> | undefined;
const gate = createCreditGate(createMessageChannelTick());
const locks = createLocks();

/** Resolved while no query is running; `close` waits on it before closing. */
let queryRunning: PromiseWithResolvers<void> | undefined;
const idleUntilQueryEnds = () => queryRunning?.promise ?? Promise.resolve();
let closing = false;

type OpenOptions = {
  vfs: SQLiteVFS;
  build?: SQLiteBuild;
  wasm?: WasmLocation;
  pragmas?: Record<string, string>;
};

/**
 * The Emscripten module argument carrying the consumer's `wasmUrl`, or
 * `undefined` when they gave none.
 *
 * `undefined` is not a detail. `findWasmBinary` reads
 * `if (Module["locateFile"])` and otherwise takes its
 * `new URL('wa-sqlite.wasm', import.meta.url)` branch — the branch a bundler
 * rewrites to the hashed asset it emitted. Setting `locateFile`
 * unconditionally, even to a faithful pass-through, would leave that branch
 * for a path built from the worker's own directory, where no hashed asset
 * exists. Every bundled consumer would break to serve a hand-moved one.
 *
 * The two forms differ in who names the file: with a `base`, the glue passes
 * its own file name and each build finds its own `.wasm` from one directory;
 * with a `file`, the caller has named a specific build's asset, so the glue's
 * name is discarded.
 */
const wasmModuleArg = (wasm: WasmLocation | undefined) =>
  wasm === undefined
    ? undefined
    : {
        locateFile:
          'base' in wasm ? (path: string) => wasm.base + path : () => wasm.file,
      };

/**
 * Called once per worker thread when the client sends the `open` message.
 * Loads the wa-sqlite WASM module and VFS, acquires the initialization lock to
 * prevent parallel DB opens across the pool, opens the SQLite database, then
 * transitions this worker to READY and replaces the top-level message handler
 * with the query handler.
 *
 * Database open is serialised by a `navigator.locks` lock on `initLockName(file)`.
 * On success, posts a `ready` message; `src/pool.ts` then transitions the worker
 * label from `NEW` to `READY`.
 *
 * @param file - Normalized database file name passed from `createSQLiteClient`.
 * @param options - VFS selection and PRAGMA map.
 */
const open = (file: string, options: OpenOptions) => {
  if (openedDB) {
    throw new Error('DB already opened');
  }

  const { vfs, wasm, pragmas = {} } = options;
  const build = options.build ?? defaultBuildFor(vfs);

  const vfsConfig = VFSConfigs[vfs];

  openedDB = WA_SQLITE_BUILDS[build]()
    .then(({ default: factory }) => factory(wasmModuleArg(wasm)))
    .then((module) => {
      const sqlite = SQLite.Factory(module);
      return vfsConfig.fs().then((vfsModule) => ({
        sqlite,
        module,
        vfsModule: (vfsModule as unknown as Record<string, VFSClass>)[vfs],
      }));
    })
    .then(({ sqlite, module, vfsModule }) => {
      return (
        vfsModule.create(vfs, module, { lockPolicy: 'shared' }) as Promise<any>
      ).then((vfsInstance: any) => {
        sqlite.vfs_register(vfsInstance, true);
        // One lock for open + pragmas. withLock releases on throw too, which
        // is what the explicit unlock() in the old .catch existed to do.
        //
        // `file` arrives already normalized from `createSQLiteClient`, so
        // two clients spelling the same database differently (e.g. 'data' vs
        // './data') always compete on the same lock and open the same file.
        // The relative form is intentional: sqlite3_open_v2 checks
        // nPathname + 8 > mxPathname (64, wa-sqlite/src/VFS.js:10) before
        // xOpen, so an absolute name costs a character the budget cannot spare
        // (measured: broke all 96 browser tests on 56-char names). The VFS
        // normalizes internally, so 'data' and '/data' open the same OPFS file.
        return locks.withLock(initLockName(file), async () => {
          const db = await sqlite.open_v2(file);
          for (const statement of renderPragmas(pragmas)) {
            for await (const stmt of sqlite.statements(db, statement)) {
              while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
            }
          }
          return { sqlite, db };
        });
      });
    })
    .then((opened) => {
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
    .catch((error: unknown) => {
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message:
          error instanceof Error ? error.message : `Failed to open ${file}`,
        cause: cloneable(error),
        // wa-sqlite raises SQLiteError(message, code) with SQLite's numeric
        // result code. Carry it across the postMessage boundary so pool.ts
        // can mint SQLiteError('BUSY') rather than SQLiteError('WORKER_CRASHED').
        ...(typeof (error as { code?: unknown })?.code === 'number'
          ? { sqliteCode: (error as { code: number }).code }
          : {}),
      });
      throw error;
    });

  // Nothing awaits openedDB until a query arrives; keep a failed open from
  // becoming an unhandled rejection in the worker.
  openedDB.catch(() => {});

  const reply = (data: WorkerMessageData) => {
    self.postMessage(data);
  };

  // One query at a time per worker (a worker holds one lease), so a single
  // counter cannot interleave. Reset by the `query` case, read by its reply.
  let prepared = 0;

  // `cloneable` is defined at module level; see below.

  const query = async function* (
    sql: string,
    params: unknown[],
    options?: SQLOptions,
  ) {
    if (!openedDB) throw new Error('No DB opened');

    const { sqlite, db } = await openedDB;
    const { chunkSize = 1 } = options ?? {};

    const buffer = [];

    for await (const stmt of sqlite.statements(db, sql)) {
      prepared++;
      if (params?.length) {
        sqlite.bind_collection(stmt, params);
      }
      const cols = sqlite.column_names(stmt) as string[];

      while (true) {
        if (gate.isStopped()) break;

        const result = await sqlite.step(stmt);
        if (gate.isStopped()) break;

        if (result === SQLITE_ROW) {
          const row = sqlite.row(stmt);
          const rowObject = Object.fromEntries(
            cols.map((key, i) => [key, row[i]]),
          );
          buffer.push(rowObject);

          if (buffer.length >= chunkSize) {
            yield buffer.splice(0, chunkSize);
          }
        } else {
          while (buffer.length) {
            yield buffer.splice(0, chunkSize);
          }
          break;
        }
      }
    }
    yield sqlite.changes(db);
  };

  self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
    const { data } = event;
    switch (data.type) {
      case 'query': {
        const { callId, sql, params, options } = data;
        try {
          // Reset the credit gate for this call. pool.ts sets the worker's
          // status to RUNNING after posting the query.
          gate.reset(callId, options?.credits ?? DEFAULT_CREDIT_WINDOW);
          prepared = 0;
          queryRunning = Promise.withResolvers<void>();
          let affected = 0;

          for await (const chunk of query(sql, params, options)) {
            if (typeof chunk === 'number') {
              affected = chunk;
              break;
            }
            if ((await gate.take(callId)) === 'stopped') break;
            reply({ type: 'chunk', callId, data: chunk });
          }

          if (closing) {
            reply({
              type: 'error',
              callId,
              message: 'The SQLite client has been closed.',
            });
          } else {
            reply({ type: 'done', callId, affected, prepared });
          }
        } catch (e) {
          reply({
            type: 'error',
            callId,
            ...(typeof e === 'object'
              ? e instanceof Error
                ? { message: e.message, cause: cloneable(e.cause) }
                : { message: 'Unknown error', cause: e }
              : { message: `Unknown error (${e})` }),
            // wa-sqlite raises SQLiteError(message, code) with SQLite's numeric
            // result code. Without this the code dies at the postMessage
            // boundary and the client can only string-match the message.
            ...(typeof (e as { code?: unknown })?.code === 'number'
              ? { sqliteCode: (e as { code: number }).code }
              : {}),
          });
        } finally {
          queryRunning?.resolve();
          queryRunning = undefined;
        }
        break;
      }
      case 'close': {
        // Spec §5.3: with the tick, `close` is deliverable mid-query for the
        // first time. Closing a database under a live statement returns
        // SQLITE_BUSY, which the catch below would swallow while the row loop
        // kept running. Stop first, let the query unwind, then close.
        closing = true;
        gate.stop();
        await idleUntilQueryEnds();
        try {
          const { sqlite, db } = await openedDB!;
          await sqlite.close(db);
        } catch {
          // A database that never opened has nothing to close; the client is
          // shutting down either way and must still get its reply.
        }
        reply({ type: 'closed', callId: 0 });
        break;
      }
      case 'open': {
        // A second open is a protocol error; open() already guards against this.
        throw new Error('DB already opened');
      }
      case 'delete': {
        // A delete worker never opens a database, so this message cannot arrive
        // here: it is handled by the top-level onmessage before open() runs.
        throw new Error(
          'delete message cannot arrive after a database is opened',
        );
      }
      case 'credit': {
        gate.grant(data.callId, data.n);
        break;
      }
      case 'stop': {
        gate.stop();
        break;
      }
      default: {
        const _unexpected: never = data;
        throw new Error(
          `Unhandled worker message: ${JSON.stringify(_unexpected)}`,
        );
      }
    }
  };
};

/**
 * A cause that cannot be structured-cloned makes `postMessage` itself throw —
 * inside the catch block — so the client receives nothing and waits forever.
 */
const cloneable = (value: unknown): unknown => {
  try {
    structuredClone(value);
    return value;
  } catch {
    return String(value);
  }
};

/**
 * The database and the two siblings SQLite may leave beside it. The set is
 * upstream's own (`OPFSCoopSyncVFS.js:8`), not a guess: a stale `-journal` next
 * to a deleted database is a hot journal, and recreating a database of that
 * name would have SQLite attempt a rollback from it. On `AccessHandlePoolVFS`
 * each sibling also occupies its own pool slot.
 */
const DB_RELATED_SUFFIXES = ['', '-journal', '-wal'] as const;

/**
 * Removes one OPFS entry if it is there, walking the path's directories.
 * A missing entry is success — which is what makes this pass inert should
 * upstream's `jDelete` start removing the file itself.
 */
const removeOpfsEntry = async (path: string): Promise<void> => {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }
    await dir.removeEntry(name);
  } catch (error) {
    if ((error as DOMException)?.name === 'NotFoundError') return;
    throw error;
  }
};

/**
 * Deletes a database without opening it.
 *
 * The VFS is instantiated because `jDelete` is the only correct removal on
 * `AccessHandlePoolVFS` — it un-associates the SQLite path and returns the slot
 * to the pool, where deleting the OPFS file by name would match nothing.
 *
 * The second pass exists because two of the seven persistent `jDelete`
 * implementations do not delete: `OPFSCoopSyncVFS` truncates a file it never
 * removes, and is a silent no-op for a database that is not open — which is
 * every database here, since nothing is opened; `OPFSWriteAheadVFS` throws for
 * anything that is not a bound temporary file. Both keep the database at the
 * plain OPFS path, so the remedy is the `removeEntry` the other two OPFS VFS
 * already perform internally. It runs for all four `opfs-path` VFS rather than
 * for an exception list, because it is idempotent and a list would be a second
 * place to update when a VFS is added.
 */
const deleteDatabaseFiles = async (data: {
  file: string;
  vfs: SQLiteVFS;
  build?: SQLiteBuild;
  wasm?: WasmLocation;
}) => {
  const { file, vfs, wasm } = data;
  const build = data.build ?? defaultBuildFor(vfs);

  const { default: factory } = await WA_SQLITE_BUILDS[build]();
  const module = await factory(wasmModuleArg(wasm));
  const vfsModule = (await VFSConfigs[vfs].fs()) as unknown as Record<
    string,
    VFSClass
  >;
  const vfsInstance = (await vfsModule[vfs].create(vfs, module, {
    lockPolicy: 'shared',
  })) as any;

  try {
    for (const suffix of DB_RELATED_SUFFIXES) {
      // Pass syncDir=1, not 0. IDBBatchAtomicVFS.jDelete (wa-sqlite
      // IDBBatchAtomicVFS.js:119-133) only awaits its IndexedDB transaction
      // when syncDir is truthy — with 0 the delete is queued on #chain but
      // the worker exits before it commits, leaving the data intact.
      // OPFSAdaptiveVFS, OPFSAnyContextVFS and IDBMirrorVFS honour the same
      // flag with `if (syncDir) await result`; the remaining VFS ignore it.
      await vfsInstance.jDelete(`${file}${suffix}`, 1);
    }

    // Commit barrier for idb-store VFS. This call is a barrier, not a check —
    // its return value is deliberately discarded. Removing it silently
    // reintroduces the data-survives-deletion defect that invariant 7 caught.
    //
    // Why it works: IDBBatchAtomicVFS.jDelete with syncDir=1 calls sync(false),
    // which awaits #chain (IDB requests submitted) but NOT #txComplete
    // (transaction oncomplete). The rw delete transactions are still pending
    // when the worker would otherwise exit; worker termination closes the IDB
    // connection and aborts them. jAccess issues a ro transaction on the same
    // connection whose lambda returns the metadata.get promise, so #q awaits
    // the request result (IDBBatchAtomicVFS.js:146-157). Per the IndexedDB
    // specification, a ro transaction cannot acquire its object-store locks
    // until every rw transaction with overlapping scope on the same connection
    // has committed — that is a spec requirement, not engine behaviour. When
    // metadata.get's onsuccess fires, the rw deletes are durably committed.
    //
    // IDBMirrorVFS (also idb-store) is inert here: its jAccess is a pure
    // in-memory map lookup that issues no IDB transaction (IDBMirrorVFS.js:
    // 239-253), so no serialisation barrier is created. That is harmless
    // because IDBMirrorVFS.#deleteFile already awaits oncomplete before
    // returning (IDBMirrorVFS.js:738-751).
    //
    // The gate is by layout declaration, not by VFS name, keeping with this
    // project's convention that VFS behaviour is declared once in
    // VFS_CAPABILITIES and never special-cased by name. A future idb-store VFS
    // inherits the barrier, which is either needed (like IDBBatchAtomicVFS) or
    // inert (like IDBMirrorVFS).
    if (VFS_CAPABILITIES[vfs].layout === 'idb-store') {
      const pResOut = new DataView(new ArrayBuffer(4));
      await vfsInstance.jAccess(`${file}`, 0, pResOut);
    }
  } finally {
    await vfsInstance.close?.();
  }

  if (VFS_CAPABILITIES[vfs].layout === 'opfs-path') {
    for (const suffix of DB_RELATED_SUFFIXES) {
      await removeOpfsEntry(`${file}${suffix}`);
    }
  }
};

// Top-level message handler: processes only 'open' messages.
// After open() completes, the query handler installed inside open() takes over
// and this handler is no longer the active responder for incoming messages.
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
  const { data } = event;
  switch (data.type) {
    case 'open': {
      const { file, vfs, build, pragmas } = data;
      open(file, { vfs, build, pragmas });
      break;
    }
    case 'delete': {
      deleteDatabaseFiles(data)
        .then(() => {
          self.postMessage({ type: 'deleted', callId: 0 });
        })
        .catch((error: unknown) => {
          self.postMessage({
            type: 'error',
            callId: 0,
            message:
              error instanceof Error
                ? error.message
                : `Failed to delete ${data.file}`,
            cause: cloneable(error),
            ...(typeof (error as { code?: unknown })?.code === 'number'
              ? { sqliteCode: (error as { code: number }).code }
              : {}),
          });
        });
      break;
    }
    case 'query': {
      // queries arrive only after open() replaces self.onmessage; this case
      // is unreachable at runtime but satisfies the exhaustive check.
      break;
    }
    case 'close': {
      // close arrived before open completed — no database to close; reply immediately.
      self.postMessage({ type: 'closed', callId: 0 });
      break;
    }
    // No query can be running before open.
    case 'credit':
    case 'stop': {
      break;
    }
    default: {
      const _unexpected: never = data;
      throw new Error(
        `Unhandled worker message: ${JSON.stringify(_unexpected)}`,
      );
    }
  }
};
