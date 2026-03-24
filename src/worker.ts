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
import { shouldLog } from './logger';
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import { SQLITE_ROW } from 'wa-sqlite/src/sqlite-constants.js';
import { WorkerOrchestrator, WorkerStatuses } from './orchestrator';
import type { ClientMessageData, LogLevel, SQLiteVFS, WorkerMessageData } from './types';

type SQLOptions = { chunkSize?: number; signal?: AbortSignal };

let currentLogLevel: LogLevel = 'warn';

/**
 * Posts a log message to the client thread if the message level passes
 * the current threshold (worker-side filtering — D-05).
 * The client's onmessage handler dispatches it through LL (real or shim).
 */
function log(level: LogLevel, scope: string, ...args: unknown[]): void {
	if (shouldLog(level, currentLogLevel)) {
		self.postMessage({ type: 'log', level, scope, args } satisfies WorkerMessageData);
	}
}

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
  log('debug', `sqlite/worker ${index + 1}`, 'open() called with file:', file);
  if (openedDB) {
    log('error', `sqlite/worker ${index + 1}`, 'Error: DB already opened');
    throw new Error('DB already opened');
  }

  orchestrator = new WorkerOrchestrator(flags);

  const { vfs = 'OPFSCoopSyncVFS', pragmas = {} } = options ?? {};

  const allQueryPragmas = !Object.keys(pragmas).length
    ? ''
    : Object.entries(pragmas)
        .map(([key, val]) => `PRAGMA ${key}=${val};`)
        .join('');

  const vfsConfig = VFSConfigs[vfs];

  log('debug', `sqlite/worker ${index + 1}`, 'Open', file, 'using VFS:', vfs);

  openedDB = vfsConfig
    .module()
    .then(({ default: factory }) => factory())
    .then((module) => {
      log('verb', `sqlite/worker ${index + 1}`, 'SQLite module loaded');
      const sqlite = SQLite.Factory(module);
      return vfsConfig.fs().then((vfsModule) => ({
        sqlite,
        module,
        vfsModule: (vfsModule as unknown as Record<string, VFSClass>)[vfs],
      }));
    })
    .then(({ sqlite, module, vfsModule }) => {
      log('verb', `sqlite/worker ${index + 1}`, 'VFS module loaded:', vfs);
      return (
        vfsModule.create(vfs, module, { lockPolicy: 'shared' }) as Promise<any>
      ).then((vfsInstance: any) => {
        log('verb', `sqlite/worker ${index + 1}`, 'VFS instance created');
        sqlite.vfs_register(vfsInstance, true);

        log('debug', `sqlite/worker ${index + 1}`, 'Acquiring initLock to open DB');
        orchestrator.lock();
        log('debug', `sqlite/worker ${index + 1}`, 'initLock acquired, opening DB now');
        const openTime = Date.now();
        return sqlite.open_v2(file).then((db: any) => {
          log(
            'debug',
            `sqlite/worker ${index + 1}`,
            'Database',
            file,
            'opened in',
            Date.now() - openTime,
            'ms',
          );
          return { sqlite, db };
        });
      });
    })
    .catch((e) => {
      log('warn', `sqlite/worker ${index + 1}`, 'Error during open:', e);
      throw e;
    })
    .finally(() => {
      log('debug', `sqlite/worker ${index + 1}`, 'Releasing initLock after open');
      orchestrator.unlock();
      log('debug', `sqlite/worker ${index + 1}`, 'Database opened and ready');
      // Transition: INITIALIZING → READY
      // Marks this worker as available for queries. The client's releaseWorker()
      // observes READY status and dispatches queued requests to this worker.
      orchestrator.setStatus(index, WorkerStatuses.READY);
      self.postMessage({ type: 'ready', callId: 0 });
    });

  const reply = (data: WorkerMessageData) => {
    self.postMessage(data);
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

    for await (const stmt of sqlite.statements(
      db,
      `${allQueryPragmas}${sql}`,
    )) {
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
    log(
      'verb',
      `sqlite/worker ${index + 1}`,
      'Query handler - received message:',
      event.data.type,
    );
    const { data } = event;
    if (data.type === 'query') {
      const { callId, sql, params, options } = data;
      try {
        // Transition: READY → RUNNING
        // Signals to the client that this worker is busy. The client may set
        // status to ABORTING via AbortSignal while the worker is RUNNING.
        orchestrator.setStatus(index, WorkerStatuses.RUNNING);
        log('wth', `sqlite/worker ${index + 1}`, 'Executing query:', sql);
        let affected = 0;

        for await (const chunk of query(sql, params, options)) {
          if (typeof chunk === 'number') {
            log(
              'wth',
              `sqlite/worker ${index + 1}`,
              'Sending chunk for',
              chunk,
              'affected rows',
            );
            affected = chunk;
            break;
          } else {
            log(
              'wth',
              `sqlite/worker ${index + 1}`,
              'Sending chunk with',
              chunk.length,
              'rows',
            );
            reply({ type: 'chunk', callId, data: chunk });
          }
        }

        log('verb', `sqlite/worker ${index + 1}`, 'Query completed, affected:', affected);
        reply({ type: 'done', callId, affected });
      } catch (e) {
        log('warn', `sqlite/worker ${index + 1}`, 'Query error:', e);
        reply({
          type: 'error',
          callId,
          ...(typeof e === 'object'
            ? e instanceof Error
              ? { message: e.message, cause: e.cause }
              : { message: 'Unknown error', cause: e }
            : { message: `Unknown error (${e})` }),
        });
      } finally {
        // Transition: RUNNING | ABORTING → DONE
        // Unconditional — ensures the worker status is always reset even on error or abort.
        // The client's releaseWorker() observes DONE and routes the worker back to the pool.
        orchestrator.setStatus(index, WorkerStatuses.DONE);
      }
    }
  };
};

// Top-level message handler: processes only 'open' messages.
// After open() completes, the query handler installed inside open() takes over
// and this handler is no longer the active responder for incoming messages.
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
  const { data } = event;
  if (data.type === 'open') {
    const { file, flags, index, vfs, pragmas, logLevel } = data;
    currentLogLevel = logLevel ?? 'warn';
    open(file, flags, index, { vfs, pragmas });
  }
};
