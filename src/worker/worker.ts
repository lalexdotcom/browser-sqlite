/**
 * SQLite Web Worker entry point.
 *
 * Each worker in the pool runs this module. It handles two message types:
 * - `open` — loads the wa-sqlite WASM module, opens the database, and transitions to READY
 * - `query` — executes a SQL statement and streams results back as chunks
 *
 * Lifecycle labels (`NEW`, `READY`, `RUNNING`, `ABORTING`, `CLOSED`, `DEAD`) are
 * maintained by `src/pool.ts`, not by this module. From this worker's perspective:
 * the database open is serialised by `navigator.locks` (`initLockName(normalizeDatabaseFile(file))`);
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
  type WorkerMessageData,
} from '../types';
import { normalizeDatabaseFile, renderPragmas } from '../utils';

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
 * VFS loaders only. Which build each VFS may run on lives in `VFS_BUILDS`
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
} as const satisfies Record<SQLiteVFS, { fs: () => Promise<any> }>;

let openedDB: Promise<{ sqlite: any; db: any }> | undefined;
const gate = createCreditGate(createMessageChannelTick());
const locks = createLocks();

/** Resolved while no query is running; `close` waits on it before closing. */
let queryRunning: PromiseWithResolvers<void> | undefined;
const idleUntilQueryEnds = () => queryRunning?.promise ?? Promise.resolve();
let closing = false;

type OpenOptions = {
  vfs?: SQLiteVFS;
  build?: SQLiteBuild;
  pragmas?: Record<string, string>;
};

/**
 * Called once per worker thread when the client sends the `open` message.
 * Loads the wa-sqlite WASM module and VFS, acquires the initialization lock to
 * prevent parallel DB opens across the pool, opens the SQLite database, then
 * transitions this worker to READY and replaces the top-level message handler
 * with the query handler.
 *
 * Database open is serialised by a `navigator.locks` lock on `initLockName(normalizeDatabaseFile(file))`.
 * On success, posts a `ready` message; `src/pool.ts` then transitions the worker
 * label from `NEW` to `READY`.
 *
 * @param file - Database file name passed from `createSQLiteClient`.
 * @param options - VFS selection and PRAGMA map.
 */
const open = (file: string, options?: OpenOptions) => {
  if (openedDB) {
    throw new Error('DB already opened');
  }

  const { vfs = 'OPFSAdaptiveVFS', pragmas = {} } = options ?? {};
  const build = options?.build ?? defaultBuildFor(vfs);

  const vfsConfig = VFSConfigs[vfs];

  openedDB = WA_SQLITE_BUILDS[build]()
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
        // One lock for open + pragmas. withLock releases on throw too, which
        // is what the explicit unlock() in the old .catch existed to do.
        //
        // The lock name is normalized so two clients spelling the same file
        // differently (e.g. 'data' vs './data') always compete on the same
        // lock. The open call keeps the original `file` string: sqlite3_open_v2
        // checks nPathname + 8 > mxPathname (64, wa-sqlite/src/VFS.js:10)
        // before xOpen; the leading '/' from normalization pushes 56-char test
        // names over the budget. The VFS normalizes internally, so the same
        // OPFS file is opened regardless.
        return locks.withLock(
          initLockName(normalizeDatabaseFile(file)),
          async () => {
            const db = await sqlite.open_v2(file);
            for (const statement of renderPragmas(pragmas)) {
              for await (const stmt of sqlite.statements(db, statement)) {
                while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
              }
            }
            return { sqlite, db };
          },
        );
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
            reply({ type: 'done', callId, affected });
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
