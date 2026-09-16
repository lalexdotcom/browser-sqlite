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
 * message and is observed through the credit gate's stopped flag; on the `sync` build only,
 * `interrupt()` also delivers the abort via a shared slot that the gate never sees.
 */
import * as SQLite from 'wa-sqlite/src/sqlite-api.js';
import {
  SQLITE_CANTOPEN,
  SQLITE_INTERRUPT,
  SQLITE_OPEN_READWRITE,
  SQLITE_PREPARE_PERSISTENT,
  SQLITE_ROW,
} from 'wa-sqlite/src/sqlite-constants.js';
import {
  createCreditGate,
  createMessageChannelTick,
  DEFAULT_CREDIT_WINDOW,
} from '../credits';
import type { SQLiteErrorCode } from '../errors';
import { createLocks, initLockName } from '../locks';
import {
  type ClientMessageData,
  defaultBuildFor,
  type PlatformFeature,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type WasmLocation,
  type WorkerMessageData,
} from '../types';
import { renderPragmas } from '../utils';
import { cloneable } from './cloneable';
import { firstMissing } from './probes';
import { sqliteCodeOf } from './sqlite-code';
import { createStatementCache } from './statement-cache';

type SQLOptions = {
  chunkSize?: number;
  signal?: AbortSignal;
  abortable?: boolean;
};

/**
 * VM instructions between two progress-handler calls. Measured 2026-09-04 on
 * Chromium 151 and Firefox 153: at this value the handler is free within noise
 * on every shape, and an abort overshoots by 1-6 ms. 10x coarser saves 2-4
 * points on pure computation and costs up to 87 ms on Firefox/async — the wrong
 * side of the trade. See the design's §4.3.
 */
const PROGRESS_OPS = 100_000;

/**
 * The DOMException name a second `createSyncAccessHandle` on a held file
 * throws. Specified by the File System API, and the same on both engines —
 * unlike the message, which is engine prose ("Access Handles cannot be
 * created…" on Chromium). Never match on that.
 */
const HELD_ELSEWHERE = 'NoModificationAllowedError';

/** How long to keep waiting for a dying worker to let go, and how often. */
const ACQUIRE_RETRY_BUDGET_MS = 10_000;
const ACQUIRE_RETRY_INTERVAL_MS = 100;

/**
 * Instantiates the VFS, waiting out a worker of this origin that has just died
 * and still holds the files.
 *
 * `AccessHandlePoolVFS` acquires EVERY file in its directory exclusively, and a
 * worker killed INSIDE a statement keeps its OPFS sync access handles far
 * longer than an idle one: ~2000 ms against ~65 ms, measured on Chromium
 * 2026-09-16. Both callers open squarely inside that window — a pool worker
 * restarted by `handleDeath`, which terminates and respawns in one synchronous
 * pass, and the delete worker a consumer reaches by calling `close()` and then
 * `deleteDatabase()`, which is the ordinary sequence.
 *
 * **Waiting here is waiting for a corpse, not hoping.** The caller already
 * holds the connection lock exclusively, so no other CLIENT can be in this
 * file; on a VFS that takes its whole directory the only possible holder is a
 * worker of ours on its way out. That is what makes a retry correct rather
 * than a papering-over.
 *
 * Bounded at 10 s although `openTimeout` and `DELETE_TIMEOUT` (30 s each)
 * already bound it from outside — deliberately, and below them: a holder that
 * is NOT ours (another application on this origin using the same VFS directly)
 * must still surface the engine's own error, which says what is wrong, rather
 * than the caller's timeout, which does not. The 10 s is one measurement plus
 * margin, not a ceiling: 2039 ms was one machine, one engine, one statement.
 */
const createVfsInstance = async (
  vfsClass: VFSClass,
  vfs: string,
  module: WASQLiteModule,
): Promise<unknown> => {
  const deadline = Date.now() + ACQUIRE_RETRY_BUDGET_MS;
  for (;;) {
    try {
      return await vfsClass.create(vfs, module, { lockPolicy: 'shared' });
    } catch (error) {
      if (
        (error as { name?: string })?.name !== HELD_ELSEWHERE ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ACQUIRE_RETRY_INTERVAL_MS),
      );
    }
  }
};

/**
 * The one savepoint this library opens inside a transaction (spec 2026-09-11,
 * D7). One at a time — the next message concludes it before anything else —
 * so a fixed name suffices, and its three statements stay in the statement
 * cache. A consumer's own savepoints never sit above it.
 */
const LIBRARY_SAVEPOINT = '__bsq_sp';

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

/**
 * `SQLITE_STMTSTATUS_MEMUSED`. Not in `sqlite-constants.js` — the façade does
 * not wrap the call that uses it.
 */
const SQLITE_STMTSTATUS_MEMUSED = 99;

/**
 * The statement's retained footprint, for the cache's byte bound.
 *
 * Read in `settle` rather than after `prepare` because `settle` is the only
 * place `cache.set` is called, so no branch needs a special case and no state
 * is threaded through the generator. Measured 2026-09-02: the value does not
 * move over a statement's life — after prepare, after binding 32 765 values,
 * after step, after reset — so where it is read cannot change it. Synchronous
 * and not an I/O call, so it suspends nothing on the Asyncify build.
 */
const stmtWeight = (module: WASQLiteModule, stmt: number) =>
  module._sqlite3_stmt_status(stmt, SQLITE_STMTSTATUS_MEMUSED, 0);

let openedDB:
  | Promise<{ sqlite: SQLiteAPI; module: WASQLiteModule; db: number }>
  | undefined;
const gate = createCreditGate(createMessageChannelTick());
const locks = createLocks();

/** Resolved while no query is running; `close` waits on it before closing. */
let queryRunning: PromiseWithResolvers<void> | undefined;
const idleUntilQueryEnds = () => queryRunning?.promise ?? Promise.resolve();
let closing = false;

/**
 * Set while worker 0 waits for the client's connection lock (spec 2026-09-15,
 * §3.2). `proceed` resolves and clears it; a `close` arriving while it is set
 * is answered at once, since nothing was opened.
 */
let proceedGate: PromiseWithResolvers<void> | undefined;
// Assigned in open() before any query can arrive: the worker posts `ready`
// only after open() completes, and pool.ts does not dispatch a query until
// the worker is READY. The default 'async' is never read.
let currentBuild: SQLiteBuild = 'async';

type OpenOptions = {
  vfs: SQLiteVFS;
  build?: SQLiteBuild | undefined;
  wasm?: WasmLocation | undefined;
  pragmas?: Record<string, string> | undefined;
  statementCacheSize?: number | undefined;
  statementCacheBytes?: number | undefined;
  abortSlots?: SharedArrayBuffer | undefined;
  abortIndex?: number | undefined;
  declineWithout?: readonly PlatformFeature[] | undefined;
  probeFirst?: readonly PlatformFeature[] | undefined;
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

  // Spec 2026-09-13: before anything is loaded. A surplus worker of a pool the
  // environment caps opens nothing — no wasm, no VFS, no file — and says so,
  // so nothing fails and wa-sqlite prints nothing. The client terminates it.
  const missing = firstMissing(options.declineWithout ?? []);
  if (missing !== null) {
    self.postMessage({
      type: 'declined',
      callId: 0,
      missing,
    } satisfies WorkerMessageData);
    return;
  }

  // Spec 2026-09-15, §3.2: where the VFS is exclusive without a feature the
  // page cannot probe, report it and open nothing until the client has decided
  // the connection lock. A worker that opened first would fail on a file
  // another client holds — or take it from under that client.
  if (options.probeFirst && options.probeFirst.length > 0) {
    proceedGate = Promise.withResolvers<void>();
    self.postMessage({
      type: 'probed',
      callId: 0,
      missing: firstMissing(options.probeFirst),
    } satisfies WorkerMessageData);
  }

  const { vfs, wasm, pragmas = {}, abortSlots, abortIndex } = options;
  const build = options.build ?? defaultBuildFor(vfs);
  currentBuild = build;

  const slot =
    abortSlots && abortIndex !== undefined
      ? new Int32Array(abortSlots)
      : undefined;

  const vfsConfig = VFSConfigs[vfs];

  // Hoisted for the final `catch`. For `sqlite3_open_v2` wa-sqlite has no
  // connection to ask `sqlite3_errmsg`, so its error names only the function;
  // the VFS keeps the real one in `lastError` (spec 2026-09-13, §3.4). A fresh
  // instance per open() means the value cannot be stale.
  let vfsInstanceSeen: { lastError?: unknown } | undefined;

  openedDB = (proceedGate?.promise ?? Promise.resolve())
    .then(() => WA_SQLITE_BUILDS[build]())
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
      return (createVfsInstance(vfsModule, vfs, module) as Promise<any>).then(
        (vfsInstance: any) => {
          vfsInstanceSeen = vfsInstance;
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
          return locks.withLock(initLockName(vfs, file), async () => {
            const db = await sqlite.open_v2(file);
            for (const statement of renderPragmas(pragmas)) {
              for await (const stmt of sqlite.statements(db, statement)) {
                while ((await sqlite.step(stmt)) === SQLITE_ROW) {}
              }
            }
            return { sqlite, module, db };
          });
        },
      );
    })
    .then((opened) => {
      self.postMessage({ type: 'ready', callId: 0 });
      return opened;
    })
    .catch((error: unknown) => {
      const base =
        error instanceof Error ? error.message : `Failed to open ${file}`;
      const vfsError = vfsInstanceSeen?.lastError;
      const detail =
        vfsError instanceof Error
          ? `${vfsError.name}: ${vfsError.message}`
          : undefined;
      // Carried across the postMessage boundary so pool.ts can mint
      // SQLiteError('BUSY') rather than SQLiteError('WORKER_CRASHED') — only
      // for wa-sqlite's own SQLiteError (sqliteCodeOf), never any numeric
      // `code`: the open chain awaits navigator.storage.getDirectory() and
      // AccessHandlePoolVFS's #acquireAccessHandles(), whose DOMExceptions
      // carry a numeric legacy `code` that is not SQLite's (e.g. 18 for
      // SecurityError, which reads as SQLITE_CODES.TOOBIG).
      const sqliteCode = sqliteCodeOf(error);
      self.postMessage({
        type: 'open-error',
        callId: 0,
        message: detail ? `${base}: ${detail}` : base,
        cause: cloneable(detail ? vfsError : error),
        ...(sqliteCode !== undefined ? { sqliteCode } : {}),
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

  const cache = createStatementCache({
    maxEntries: options.statementCacheSize ?? 0,
    maxBytes: options.statementCacheBytes ?? 0,
  });

  const query = async function* (
    callId: number,
    sql: string,
    params: unknown[],
    options?: SQLOptions,
  ) {
    if (!openedDB) throw new Error('No DB opened');

    const { sqlite, db, module } = await openedDB;
    const { chunkSize = 1 } = options ?? {};

    const buffer: Record<string, unknown>[] = [];

    /**
     * Stamps SQLite's extended result code on a wa-sqlite error where the
     * statement failed (spec 2026-09-14, §5.1). The connection's code describes
     * its MOST RECENT call, so it is read before any cleanup can overwrite it:
     * `settle`'s reset or finalize, or the ROLLBACK the savepoint path issues
     * after a failed conclusion. `??=`: the first stamp wins.
     */
    const stamped = (e: unknown) => {
      if (sqliteCodeOf(e) !== undefined) {
        (e as { extendedCode?: number }).extendedCode ??=
          module._sqlite3_extended_errcode(db);
      }
      return e;
    };

    /** Binds and streams one statement. Never finalises: the caller owns it. */
    const run = async function* (stmt: number) {
      try {
        if (params?.length) {
          sqlite.bind_collection(stmt, params as any);
        }
      } catch (e) {
        throw stamped(e);
      }
      // Column names are read after the first SQLITE_ROW, not before: v2
      // re-preparation happens during step(), so names read beforehand would
      // describe the old schema on a cached statement after an ALTER TABLE.
      let cols: string[] | undefined;

      while (true) {
        if (gate.isStopped()) break;

        let result: number;
        try {
          result = await sqlite.step(stmt);
        } catch (e) {
          if ((e as { code?: number })?.code === SQLITE_INTERRUPT) {
            // Two triggers, and both mean the client has already rejected:
            // a `stop` message processed by gate.stop(), or the shared slot
            // written by interrupt() on the sync build, which never yields so
            // the message cannot reach it. Break, so settle() sees a clean
            // exit and keeps the statement cached.
            break;
          }
          throw stamped(e);
        }
        if (gate.isStopped()) break;

        if (result === SQLITE_ROW) {
          cols ??= sqlite.column_names(stmt) as string[];
          const row = sqlite.row(stmt);
          // Deliberately not `Object.fromEntries(cols.map(...))`: that shape
          // allocates one two-element array per column per row on the hottest
          // path in the library. Measured 2026-08-31 over 50 000 rows x 12
          // columns — 17.5 ms against 4.4 ms on Chromium, 23 ms against 14 ms
          // on Firefox (`mem:measurements`). Same output, so nothing but the
          // allocation is lost. Do not "simplify" it back.
          const out: Record<string, unknown> = {};
          for (let i = 0; i < cols.length; i++) {
            out[cols[i] as string] = row[i];
          }
          buffer.push(out);

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
    };

    /**
     * The exit discipline, on every path out of a retained statement:
     * `reset` ends the statement's implicit transaction, which is what keeps
     * a cached statement from holding a read transaction open and poisoning
     * the barrier; `clear_bindings` is the correctness condition of reuse.
     * A statement that truly errored is finalised — `sqlite3_reset` returns the
     * failed step's code, so resetting it throws. Exception: SQLITE_INTERRUPT
     * from the abort-via-signal path also makes reset throw, but the statement
     * is still reset to its initial state and can be cached.
     */
    const settle = async (stmt: number, failed: boolean) => {
      if (failed) {
        cache.delete(sql);
        await sqlite.finalize(stmt);
        return;
      }
      try {
        await sqlite.reset(stmt);
        sqlite.clear_bindings(stmt);
      } catch (e) {
        // sqlite3_reset returns SQLITE_INTERRUPT when the statement was stopped
        // mid-step by the progress handler (abort-via-signal path). Despite
        // the non-OK return code, sqlite3_reset DOES reset the statement to
        // its initial state and it is safe to cache. Any other error is a
        // genuine failure: finalize and evict.
        if ((e as { code?: number })?.code !== SQLITE_INTERRUPT) {
          cache.delete(sql);
          await sqlite.finalize(stmt);
          return;
        }
        sqlite.clear_bindings(stmt);
      }
      for (const handle of cache.set(sql, stmt, stmtWeight(module, stmt))) {
        await sqlite.finalize(handle);
      }
    };

    const { abortable } = options ?? {};
    const wantsSignal = abortable === true;
    const canYield = currentBuild !== 'sync';
    // A VFS that must yield gets the task turn on every statement; only an
    // abortable statement may be stopped by it (`yieldsDuringStatements`).
    const yields =
      canYield && (wantsSignal || VFS_CAPABILITIES[vfs].yieldsDuringStatements);
    const polls = !canYield && wantsSignal && slot !== undefined;
    const abortedHere = () =>
      slot !== undefined && Atomics.load(slot, abortIndex as number) === callId;
    if (yields || polls) {
      sqlite.progress_handler(
        db,
        PROGRESS_OPS,
        yields
          ? async () => {
              // The task turn is what lets a queued `stop` be delivered, and
              // what lets IDBBatchAtomicVFS's IndexedDB transaction commit.
              await gate.tick();
              return wantsSignal && gate.isStopped() ? 1 : 0;
            }
          : () => (abortedHere() ? 1 : 0),
        null,
      );
    }
    try {
      const cached = cache.get(sql);

      if (typeof cached === 'number') {
        let failed = false;
        try {
          yield* run(cached);
        } catch (e) {
          failed = true;
          throw e;
        } finally {
          await settle(cached, failed);
        }
      } else if (cached === 'uncacheable') {
        // Today's path, untouched: the generator finalises what it yields.
        for await (const stmt of sqlite.statements(db, sql)) {
          prepared++;
          yield* run(stmt);
        }
      } else {
        let keep: number | undefined;
        let live: number | undefined;
        let single: boolean | undefined;
        let failed = false;
        try {
          for await (const stmt of sqlite.statements(db, sql, {
            unscoped: true,
            flags: SQLITE_PREPARE_PERSISTENT,
          })) {
            prepared++;
            single ??= isSingleStatement(sql, sqlite.sql(stmt));
            // Assigned BEFORE the rows are streamed: first() breaks out of the
            // loop, and an assignment after `yield*` would never run.
            if (single) keep = stmt;
            else live = stmt;

            yield* run(stmt);

            if (!single) {
              await sqlite.finalize(stmt);
              live = undefined;
            }
          }
        } catch (e) {
          failed = true;
          throw stamped(e);
        } finally {
          if (keep !== undefined) {
            await settle(keep, failed);
          } else if (live !== undefined) {
            // An early exit from a multi-statement string.
            await sqlite.finalize(live);
          }
          if (single === false) {
            for (const handle of cache.markUncacheable(sql)) {
              await sqlite.finalize(handle);
            }
          }
        }
      }

      yield sqlite.changes(db);
    } catch (e) {
      // Only the uncacheable branch can still reach here unstamped: its
      // prepare failures come straight from wa-sqlite's own statements()
      // generator, with no catch of ours in between. Checked 2026-09-14 in
      // sqlite-api.js: between a failed prepare and the error leaving that
      // generator, it calls only sqlite3_errmsg (read-only) and sqlite3_free
      // (memory only) — neither touches sqlite3_extended_errcode(db). The
      // cached and fresh branches already stamp in `run` and their own inner
      // catch, so `??=` makes this a no-op for those.
      throw stamped(e);
    } finally {
      if (yields || polls) sqlite.progress_handler(db, 0, () => 0, null);
    }
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

          // Spec 2026-09-11, D5: conclude the savepoint the previous
          // savepointed write left open, then open this statement's own —
          // before the statement, in that order. Through `query` itself so they
          // take the statement cache; `prepared` is reset after them so the
          // reply describes the caller's statement alone. A failure here is this
          // query's `error`, reported below like any other.
          const savepoint = options?.savepoint;
          if (savepoint) {
            const control = async (statement: string) => {
              for await (const _ of query(callId, statement, [])) {
                // Savepoint statements return no rows.
              }
            };
            try {
              if (savepoint.conclude === 'undo')
                await control(`ROLLBACK TO ${LIBRARY_SAVEPOINT}`);
              if (savepoint.conclude)
                await control(`RELEASE ${LIBRARY_SAVEPOINT}`);
              if (savepoint.open)
                await control(`SAVEPOINT ${LIBRARY_SAVEPOINT}`);
            } catch (e) {
              // Amended 2026-09-11 (final review): the worker makes that
              // death happen — on any failure in step 1 or 2 it issues a full
              // ROLLBACK before replying, so the reply reports
              // `inTransaction: false` and the transaction dies through D6
              // with that error as cause. A failure of the ROLLBACK itself is
              // swallowed: the reply below reports whatever `inTransaction`
              // actually reads, and the caller's error is this one, not that
              // one. Found by the final review: `tx.write('…; RELEASE u',
              // …)` abandoned pops `__bsq_sp` with `u`, and the next
              // conclusion fails.
              try {
                await control('ROLLBACK');
              } catch {
                // Best effort — see above.
              }
              throw e;
            } finally {
              prepared = 0;
            }
          }

          for await (const chunk of query(callId, sql, params, options)) {
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
              inTransaction: await connectionInTransaction(),
            });
          } else {
            reply({
              type: 'done',
              callId,
              affected,
              prepared,
              inTransaction: await connectionInTransaction(),
            });
          }
        } catch (e) {
          // Only for wa-sqlite's own SQLiteError (sqliteCodeOf), never any
          // numeric `code`. Without this the code dies at the postMessage
          // boundary and the client can only string-match the message.
          const sqliteCode = sqliteCodeOf(e);
          reply({
            type: 'error',
            callId,
            ...(typeof e === 'object'
              ? e instanceof Error
                ? { message: e.message, cause: cloneable(e.cause) }
                : { message: 'Unknown error', cause: e }
              : { message: `Unknown error (${e})` }),
            ...(sqliteCode !== undefined ? { sqliteCode } : {}),
            ...(typeof (e as { extendedCode?: unknown })?.extendedCode ===
            'number'
              ? {
                  sqliteExtendedCode: (e as { extendedCode: number })
                    .extendedCode,
                }
              : {}),
            ...(typeof (e as { errorCode?: unknown })?.errorCode === 'string'
              ? { errorCode: (e as { errorCode: SQLiteErrorCode }).errorCode }
              : {}),
            inTransaction: await connectionInTransaction(),
          });
        } finally {
          queryRunning?.resolve();
          queryRunning = undefined;
        }
        break;
      }
      case 'proceed': {
        proceedGate?.resolve();
        proceedGate = undefined;
        break;
      }
      case 'close': {
        if (proceedGate) {
          // Still waiting for the connection lock: nothing was opened, so
          // there is nothing to drain or close (spec 2026-09-15, §3.2).
          closing = true;
          reply({ type: 'closed', callId: 0 });
          break;
        }
        // Spec §5.3: with the tick, `close` is deliverable mid-query for the
        // first time. Closing a database under a live statement returns
        // SQLITE_BUSY, which the catch below would swallow while the row loop
        // kept running. Stop first, let the query unwind, then close.
        closing = true;
        gate.stop();
        await idleUntilQueryEnds();
        try {
          const { sqlite, db } = await openedDB!;
          // SQLite refuses to close a connection carrying live statements,
          // and the catch below would swallow the SQLITE_BUSY. idleUntilQueryEnds
          // has already returned, so the in-flight query's statement is reset
          // and filed: nothing here is in use.
          for (const handle of cache.drain()) {
            await sqlite.finalize(handle);
          }
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
 * Whether `sql` compiled to exactly one statement, decided from the text
 * `sqlite3_sql` returns for the first statement — its own span of the input,
 * not the whole input. Asked before the first `step`, because `first()` and an
 * aborted read both leave the generator early and would never learn a count.
 *
 * Normalisation is edge whitespace and one trailing semicolon, applied
 * identically to both sides, which are two views of the same text: nothing is
 * case-folded, and an interior newline sits in the same place on both sides.
 * A false negative costs a compilation; a false positive would replay only
 * the first statement of a multi-statement string, so the failure direction
 * is the safe one.
 */
const isSingleStatement = (sql: string, statementText: string) => {
  const normalize = (s: string) => s.trim().replace(/;+$/, '').trim();
  return normalize(sql) === normalize(statementText);
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
}): Promise<boolean> => {
  const { file, vfs, wasm } = data;
  const build = data.build ?? defaultBuildFor(vfs);

  const { default: factory } = await WA_SQLITE_BUILDS[build]();
  const module = await factory(wasmModuleArg(wasm));
  const vfsModule = (await VFSConfigs[vfs].fs()) as unknown as Record<
    string,
    VFSClass
  >;
  const vfsInstance = (await createVfsInstance(
    vfsModule[vfs],
    vfs,
    module,
  )) as any;

  // Probe: open without SQLITE_OPEN_CREATE to detect absence. SQLITE_CANTOPEN
  // (14) means the database is not there. Any other error is a genuine failure
  // and must not be swallowed as DATABASE_NOT_FOUND — a corrupt database
  // returns SQLITE_CORRUPT, and a WASM/VFS start-up failure throws before
  // open_v2 is reached at all. Measured on all seven persistent VFS, n=3,
  // both engines: the signal is uniform and unambiguous.
  const sqlite = SQLite.Factory(module);
  sqlite.vfs_register(vfsInstance, true);
  try {
    const db = await sqlite.open_v2(file, SQLITE_OPEN_READWRITE);
    // Database exists; close the handle at once and proceed to deletion.
    // The same vfsInstance services both this probe and the jDelete calls
    // below, so no re-acquisition of OPFS access handles is needed.
    await sqlite.close(db);
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === SQLITE_CANTOPEN) {
      // Nothing to delete. Close the VFS instance and report absence —
      // no jDelete and no opfs-path second pass, because those would
      // operate on files the probe just confirmed are not there.
      await vfsInstance.close?.();
      return false;
    }
    throw error;
  }

  const layout = VFS_CAPABILITIES[vfs].layout;

  try {
    // Not on the opfs-path layout: the OPFS pass below removes every file there,
    // after the VFS has closed, so jDelete adds nothing there — and OPFSWriteAheadVFS's
    // refuses anything but its own temporary files, logging an error per call
    // (three per deletion, on every engine; 2026-09-14). No test can see that
    // console: it belongs to the delete worker.
    if (layout !== 'opfs-path') {
      for (const suffix of DB_RELATED_SUFFIXES) {
        // Pass syncDir=1, not 0. IDBBatchAtomicVFS.jDelete (wa-sqlite
        // IDBBatchAtomicVFS.js:119-133) only awaits its IndexedDB transaction
        // when syncDir is truthy — with 0 the delete is queued on #chain but
        // the worker exits before it commits, leaving the data intact.
        // OPFSAdaptiveVFS, OPFSAnyContextVFS and IDBMirrorVFS honour the same
        // flag with `if (syncDir) await result`; the remaining VFS ignore it.
        await vfsInstance.jDelete(`${file}${suffix}`, 1);
      }
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
    if (layout === 'idb-store') {
      const pResOut = new DataView(new ArrayBuffer(4));
      await vfsInstance.jAccess(`${file}`, 0, pResOut);
    }
  } finally {
    await vfsInstance.close?.();
  }

  if (layout === 'opfs-path') {
    // Sidecars first, the main file (suffix '') last. If a sidecar removal
    // then failed while the main file went first, the file this VFS opens to
    // probe existence would already be gone: the next deleteDatabase answers
    // DATABASE_NOT_FOUND and nothing public can remove the sidecar left
    // behind. Removing the main file last means a failure here always still
    // leaves it in place, so a retried deleteDatabase finds the database and
    // tries again. No test can inject the failed removal this guards against.
    for (const suffix of [
      ...DB_RELATED_SUFFIXES.filter((suffix) => suffix !== ''),
      ...VFS_CAPABILITIES[vfs].extraFileSuffixes,
    ]) {
      await removeOpfsEntry(`${file}${suffix}`);
    }
    await removeOpfsEntry(file);
  }

  return true;
};

/**
 * Whether the connection is inside a transaction right now. Read after every
 * query and sent with its reply, because SQLite can leave a transaction by
 * itself — an interrupted write rolls the whole transaction back
 * (https://www.sqlite.org/c3ref/interrupt.html) — and the client has no other
 * way to learn it. `undefined` when no connection is open.
 */
const connectionInTransaction = async (): Promise<boolean | undefined> => {
  if (!openedDB) return undefined;
  try {
    const { sqlite, db } = await openedDB;
    return sqlite.get_autocommit(db) === 0;
  } catch {
    return undefined;
  }
};

// Top-level message handler: processes only 'open' messages.
// After open() completes, the query handler installed inside open() takes over
// and this handler is no longer the active responder for incoming messages.
self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
  const { data } = event;
  switch (data.type) {
    case 'open': {
      const {
        file,
        vfs,
        build,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
        abortSlots,
        abortIndex,
        declineWithout,
        probeFirst,
      } = data;
      open(file, {
        vfs,
        build,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
        abortSlots,
        abortIndex,
        declineWithout,
        probeFirst,
      });
      break;
    }
    case 'delete': {
      deleteDatabaseFiles(data)
        .then((found) => {
          if (found) {
            self.postMessage({ type: 'deleted', callId: 0 });
          } else {
            self.postMessage({ type: 'not-found' });
          }
        })
        .catch((error: unknown) => {
          // Only for wa-sqlite's own SQLiteError (sqliteCodeOf), never any
          // numeric `code`: this path rethrows every DOMException but
          // NotFoundError, and a DOMException's legacy `code` is numeric
          // (e.g. 18 for SecurityError) but is not SQLite's.
          const sqliteCode = sqliteCodeOf(error);
          self.postMessage({
            type: 'error',
            callId: 0,
            message:
              error instanceof Error
                ? error.message
                : `Failed to delete ${data.file}`,
            cause: cloneable(error),
            ...(sqliteCode !== undefined ? { sqliteCode } : {}),
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
    case 'stop':
    // open() replaces this handler synchronously; proceed always arrives after.
    case 'proceed': {
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
