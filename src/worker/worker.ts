/**
 * SQLite Web Worker entry point.
 *
 * Each worker in the pool runs this module. It handles two message types:
 * - `open` — loads the wa-sqlite WASM module, opens the database, and transitions to READY
 * - `query` — executes a SQL statement and streams results back as chunks
 *
 * State transitions driven by this module:
 *   NEW → INITIALIZING (lock acquired) → INITIALIZED → READY → RUNNING → DONE
 *   RUNNING → ABORTING (set by client via AbortSignal) → DONE
 */
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
import { WorkerOrchestrator, WorkerStatuses } from '../orchestrator';
import type { ClientMessageData, SQLiteVFS, WorkerMessageData } from '../types';
import { renderPragmas } from '../utils';

type SQLOptions = { chunkSize?: number; signal?: AbortSignal };

const WA_SQLITE_MODULES = {
  wa_sqlite: () =>
    import(/* webpackChunkName: "wa-sqlite" */ 'wa-sqlite/dist/wa-sqlite.mjs'),
  wa_sqlite_async: () =>
    import(
      /* webpackChunkName: "wa-sqlite-async" */ 'wa-sqlite/dist/wa-sqlite-async.mjs'
    ),
  wa_sqlite_jspi: () =>
    import(
      /* webpackChunkName: "wa-sqlite-jspi" */ 'wa-sqlite/dist/wa-sqlite-jspi.mjs'
    ),
};

const VFSConfigs = {
  OPFSPermutedVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSPermutedVFS" */ 'wa-sqlite/src/examples/OPFSPermutedVFS.js'
      ),
    module: WA_SQLITE_MODULES.wa_sqlite_async,
  },
  OPFSAdaptiveVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSAdaptiveVFS" */ 'wa-sqlite/src/examples/OPFSAdaptiveVFS.js'
      ),
    module: WA_SQLITE_MODULES.wa_sqlite_jspi,
  },
  OPFSCoopSyncVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "OPFSCoopSyncVFS" */ 'wa-sqlite/src/examples/OPFSCoopSyncVFS.js'
      ),
    module: WA_SQLITE_MODULES.wa_sqlite,
  },
  AccessHandlePoolVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "AccessHandlePoolVFS" */ 'wa-sqlite/src/examples/AccessHandlePoolVFS.js'
      ),
    module: WA_SQLITE_MODULES.wa_sqlite,
  },
  IDBBatchAtomicVFS: {
    fs: () =>
      import(
        /* webpackChunkName: "IDBBatchAtomicVFS" */ 'wa-sqlite/src/examples/IDBBatchAtomicVFS.js'
      ),
    module: WA_SQLITE_MODULES.wa_sqlite_async,
  },
} as const satisfies Record<
  SQLiteVFS,
  { name?: string; fs: () => Promise<any>; module: () => Promise<any> }
>;

let orchestrator: WorkerOrchestrator;
let openedDB: Promise<{ sqlite: any; db: any }> | undefined;

type OpenOptions = {
  vfs?: SQLiteVFS;
  pragmas?: Record<string, string>;
};

/**
 * Called once per worker thread when the client sends the `open` message.
 * Loads the wa-sqlite WASM module and VFS, acquires the orchestrator initialization
 * lock to prevent parallel DB opens across the pool, opens the SQLite database,
 * then transitions this worker to READY and replaces the top-level message handler
 * with the query handler.
 *
 * State transition: NEW → INITIALIZING (lock acquired) → INITIALIZED → READY
 *
 * @param file - Database file name passed from `createSQLiteClient`.
 * @param flags - SharedArrayBuffer from the orchestrator, used to construct
 *   a worker-side `WorkerOrchestrator` view for status and lock operations.
 * @param index - This worker's index in the pool (0-based).
 * @param options - VFS selection and PRAGMA map.
 */
const open = (
  file: string,
  flags: SharedArrayBuffer,
  index: number,
  options?: OpenOptions,
) => {
  if (openedDB) {
    throw new Error('DB already opened');
  }

  orchestrator = new WorkerOrchestrator(flags);

  const { vfs = 'OPFSCoopSyncVFS', pragmas = {} } = options ?? {};

  const vfsConfig = VFSConfigs[vfs];

  openedDB = vfsConfig
    .module()
    .then(({ default: factory }) => factory())
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

        orchestrator.lock();
        return sqlite.open_v2(file).then((db: any) => {
          return { sqlite, db };
        });
      });
    })
    .then(async (opened) => {
      const { sqlite, db } = opened;
      // Applied once, here — the JSDoc and the README have always said "on
      // open", while the code prepended them to every query (B4). A failure
      // falls through to the .catch below, which unlocks and posts open-error.
      for (const statement of renderPragmas(pragmas)) {
        for await (const stmt of sqlite.statements(db, statement)) {
          // Some pragmas return a row (PRAGMA journal_mode=WAL returns "wal");
          // stepping to completion is what actually applies them.
          while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
        }
      }
      orchestrator.unlock();
      // Transition: INITIALIZING → READY. Only on success — the previous
      // `.finally()` posted `ready` even for a database that never opened.
      orchestrator.setStatus(index, WorkerStatuses.READY);
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
    .catch((error: unknown) => {
      orchestrator.unlock();
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message:
          error instanceof Error ? error.message : `Failed to open ${file}`,
        cause: cloneable(error),
      });
      throw error;
    });

  // Nothing awaits openedDB until a query arrives; keep a failed open from
  // becoming an unhandled rejection in the worker.
  openedDB.catch(() => {});

  const reply = (data: WorkerMessageData) => {
    self.postMessage(data);
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
      if (params?.length) {
        sqlite.bind_collection(stmt, params);
      }
      const cols = sqlite.column_names(stmt) as string[];

      while (true) {
        // Abort check: if client set status to ABORTING (via AbortSignal),
        // stop processing rows and exit. The generator yields sqlite.changes()
        // after the loop, then the handler posts 'done' to the client.
        if (orchestrator.getStatus(index) === WorkerStatuses.ABORTING) break;

        const result = await sqlite.step(stmt);
        if (orchestrator.getStatus(index) === WorkerStatuses.ABORTING) break;

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
          // Transition: READY → RUNNING
          // Signals to the client that this worker is busy. The client may set
          // status to ABORTING via AbortSignal while the worker is RUNNING.
          orchestrator.setStatus(index, WorkerStatuses.RUNNING);
          let affected = 0;

          for await (const chunk of query(sql, params, options)) {
            if (typeof chunk === 'number') {
              affected = chunk;
              break;
            } else {
              reply({ type: 'chunk', callId, data: chunk });
            }
          }

          reply({ type: 'done', callId, affected });
        } catch (e) {
          reply({
            type: 'error',
            callId,
            ...(typeof e === 'object'
              ? e instanceof Error
                ? { message: e.message, cause: cloneable(e.cause) }
                : { message: 'Unknown error', cause: e }
              : { message: `Unknown error (${e})` }),
          });
        } finally {
          // Transition: RUNNING | ABORTING → DONE
          // Unconditional — ensures the worker status is always reset even on error or abort.
          // The client's releaseWorker() observes DONE and routes the worker back to the pool.
          orchestrator.setStatus(index, WorkerStatuses.DONE);
        }
        break;
      }
      case 'close': {
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
      default: {
        const _unexpected: never = data;
        throw new Error(
          `Unhandled worker message: ${JSON.stringify(_unexpected)}`,
        );
      }
    }
  };
};

// Top-level message handler: processes only 'open' messages.
// After open() completes, the query handler installed inside open() takes over
// and this handler is no longer the active responder for incoming messages.
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
  const { data } = event;
  switch (data.type) {
    case 'open': {
      const { file, flags, index, vfs, pragmas } = data;
      open(file, flags, index, { vfs, pragmas });
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
    default: {
      const _unexpected: never = data;
      throw new Error(
        `Unhandled worker message: ${JSON.stringify(_unexpected)}`,
      );
    }
  }
};
