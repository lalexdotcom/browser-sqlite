/**
 * SQLite Web Worker entry point.
 *
 * Each worker in the pool runs this module. Among the messages it handles:
 * - `open` — loads the wa-sqlite WASM module, opens the database, and transitions to READY
 * - `query` — executes a SQL statement and streams results back as chunks
 * - `verdict` — prepares a SQL statement and says whether it reads or writes
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
  SQLITE_ATTACH,
  SQLITE_AUTH,
  SQLITE_CANTOPEN,
  SQLITE_DENY,
  SQLITE_DETACH,
  SQLITE_FUNCTION,
  SQLITE_INTERRUPT,
  SQLITE_OK,
  SQLITE_OPEN_READWRITE,
  SQLITE_PRAGMA,
  SQLITE_PREPARE_PERSISTENT,
  SQLITE_READ,
  SQLITE_RECURSIVE,
  SQLITE_ROW,
  SQLITE_SAVEPOINT,
  SQLITE_SELECT,
  SQLITE_TRANSACTION,
} from 'wa-sqlite/src/sqlite-constants.js';
import {
  classifyStatement,
  type PrepareFacts,
  type StatementKind,
} from '../classify';
import type { SQLiteBuild } from '../const/builds';
import type { PlatformFeature } from '../const/platform';
import { folderOf, type SQLiteVFS, VFS_CAPABILITIES } from '../const/vfs';
import {
  createCreditGate,
  createMessageChannelTick,
  DEFAULT_CREDIT_WINDOW,
} from '../credits';
import { createLocks, initLockName } from '../locks';
import type { SQLiteErrorCode } from '../types/errors';
import {
  type BootStage,
  type ClientMessageData,
  KILLED_SLOT,
  type ParamsBlock,
  type RefuseWrite,
  type RowsBlock,
  type Verdict,
  type WasmLocation,
  type WorkerMessageData,
} from '../types/protocol';
import { DATABASE_FILE_SUFFIXES, renderPragmas } from '../utils';
import { bindBlock, RowWriter } from './binary';
import { cloneable } from './cloneable';
import { isHeldElsewhere } from './held';
import { firstMissing } from './probes';
import { sqliteCodeOf } from './sqlite-code';
import { createStatementCache } from './statement-cache';

type SQLOptions = {
  chunkSize?: number;
  signal?: AbortSignal;
  uncached?: boolean;
  refuseWrite?: RefuseWrite;
  multi?: boolean;
  drainWrites?: boolean;
};

/** What a `drainWrites` query posts as `affected`, ahead of its first chunk. */
class Affected {
  constructor(
    readonly affected: number,
    readonly drained: boolean,
  ) {}
}

/**
 * What the authorizer sees while a statement is prepared: the part of
 * `PrepareFacts` that only the authorizer can tell.
 */
type AuthorizerFacts = Pick<PrepareFacts, 'pragma' | 'attach'>;

/**
 * A write refused before its first step. Not a failure of the statement: it
 * never ran, so it stays cached.
 */
class WriteRefused extends Error {
  errorCode: RefuseWrite;
  constructor(errorCode: RefuseWrite) {
    super(
      errorCode === 'NOT_A_READ_QUERY'
        ? 'first() only accepts reads; this statement writes.'
        : errorCode === 'READ_ONLY_TRANSACTION'
          ? 'Cannot write in a read-only transaction.'
          : 'A write was routed as a read.',
    );
    this.errorCode = errorCode;
  }
}

/**
 * The authorizer codes a read's program is made of. A statement carrying
 * `refuseWrite` that SQLite re-prepares mid-step into anything else is denied.
 */
const READ_ACTIONS = new Set<number>([
  SQLITE_READ,
  SQLITE_SELECT,
  SQLITE_FUNCTION,
  SQLITE_RECURSIVE,
  SQLITE_TRANSACTION,
  SQLITE_SAVEPOINT,
]);

/**
 * wa-sqlite hands the authorizer "" for a null argument, so a bare pragma and
 * `PRAGMA x('')` look alike: only an `=` or `(` in the text, which errs toward
 * a value, tells them apart.
 */
const pragmaIn = (
  pragma: NonNullable<PrepareFacts['pragma']>,
  text: string,
): NonNullable<PrepareFacts['pragma']> =>
  pragma.value === '' && !/[=(]/.test(text)
    ? { name: pragma.name, value: null }
    : pragma;

/** Whether a pragma, as `classifyStatement` reads it, writes. */
const pragmaWrites = (pragma: NonNullable<PrepareFacts['pragma']>) =>
  classifyStatement({ pragma, explain: false, readonly: true }) === 'write';

/** A string holding more than one statement, refused before any step. */
class MultipleStatements extends Error {
  errorCode = 'MULTIPLE_STATEMENTS' as const;
  constructor() {
    super('Only one statement per call; this string holds more.');
  }
}

/** The message of a refused transaction-control statement (spec 2026-10-04, § 4). */
const controlRefusedMessage = (
  keyword: string,
  inTransaction: boolean | undefined,
) => {
  if (!inTransaction)
    return `${keyword} is not allowed: the library manages transactions. Use db.transaction().`;
  const savepointControl =
    keyword === 'SAVEPOINT' ||
    keyword === 'RELEASE' ||
    keyword === 'ROLLBACK TO';
  return savepointControl
    ? `${keyword} is not allowed inside a transaction: the library manages it. Use tx.savepoint() for a block you can roll back on its own.`
    : `${keyword} is not allowed inside a transaction: the library manages it. Use tx.commit() or tx.rollback() to end it.`;
};

/**
 * VM instructions between two progress-handler calls. Measured 2026-09-04 on
 * Chromium 151 and Firefox 153: at this value the handler is free within noise
 * on every shape, and an abort overshoots by 1-6 ms. 10x coarser saves 2-4
 * points on pure computation and costs up to 87 ms on Firefox/async — the wrong
 * side of the trade. See the design's §4.3.
 */
const PROGRESS_OPS = 100_000;

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
  onWait: () => void,
): Promise<unknown> => {
  const deadline = Date.now() + ACQUIRE_RETRY_BUDGET_MS;
  let waiting = false;
  for (;;) {
    try {
      return await vfsClass.create(vfs, module, { lockPolicy: 'shared' });
    } catch (error) {
      if (!isHeldElsewhere(error) || Date.now() >= deadline) {
        throw error;
      }
      if (!waiting) {
        waiting = true;
        onWait();
      }
      await new Promise((resolve) =>
        setTimeout(resolve, ACQUIRE_RETRY_INTERVAL_MS),
      );
    }
  }
};

/**
 * How long to keep retrying an open that a dead context's handle is blocking.
 * Sized on the window itself: a worker killed inside a `step()` holds its OPFS
 * handles for up to ~2 s on Chromium (HANDLE-CORPSE, `mem:measurements`), and
 * 65 ms at rest. In the failures this was written for the replacement worker's
 * boot had already spent most of that window — the file was free 1-12 ms after
 * the open gave up, and a replayed attempt succeeded in 4-14 ms, 4 times out
 * of 4 (measured 2026-09-18).
 */
const OPEN_RETRY_BUDGET_MS = 2_500;

/** What an open reports when a statement the pool killed still holds the file. */
class HeldByKilledStatement extends Error {
  constructor(file: string) {
    super(
      `Could not reopen '${file}': the worker it replaces was terminated mid-statement and still holds the file. Some engines (Safari up to 27.0.1, WebKit #328618) cannot stop it. Use the async or jspi build, or cross-origin isolation, so the library can interrupt the statement.`,
    );
    this.name = 'HeldByKilledStatement';
  }
}

/**
 * `sqlite3_open_v2`, retried in a worker that replaces one the pool
 * terminated, on every VFS. Where `readwrite-unsafe` is missing,
 * `OPFSAdaptiveVFS` takes an exclusive handle in `xOpen` right after its Web
 * Lock — which a terminated worker gives back before its file — so the
 * replacement can meet its predecessor's file still held: seen once on
 * Firefox, macOS 27 (`lifecycle`'s restart failed the client with
 * `NoModificationAllowedError`, run 39620037006). That holder is a corpse and
 * lets go within milliseconds. A live holder never does (HELD-LIVE), but then
 * the open only fails `OPEN_RETRY_BUDGET_MS` later than it would have, on a
 * slot that is being restarted anyway.
 *
 * Retried only when the VFS's `lastError` names a held file (`isHeldElsewhere`);
 * any other refusal is reported at once, with that error as its cause.
 *
 * **A first open is not retried.** The one VFS that takes an exclusive handle
 * in `xOpen` with nothing of ours dead, `OPFSCoopSyncVFS`, retries a held file
 * itself for 5 s since wa-sqlite #381, past `OPEN_RETRY_BUDGET_MS`, so a retry
 * here never got a second attempt; `AccessHandlePoolVFS` takes its handles when
 * it is created, which `createVfsInstance` retries. Measured 2026-10-23
 * (POST-381, `mem:measurements/held-handles`).
 *
 * **Two budgets.** The predecessor of an `idle` death was doing nothing: a
 * corpse that lets go within `OPEN_RETRY_BUDGET_MS`. A `busy` one was
 * terminated inside a statement, which Safari up to 27.0.1 cannot stop (WebKit
 * #328618) — the thread keeps running, and the file with it, until the
 * statement ends. That wait is as long as the statement, so the open waits
 * until `openDeadline` (never less than the idle budget), and when it still
 * fails on a held file says why instead of passing the engine's bare error on.
 */
const openWithRetry = async (
  sqlite: { open_v2: (file: string) => Promise<number> },
  file: string,
  lastError: () => unknown,
  afterDeath: 'idle' | 'busy' | undefined,
  openDeadline: number | undefined,
  onWait: () => void,
): Promise<number> => {
  if (afterDeath === undefined) {
    return sqlite.open_v2(file);
  }
  const idleDeadline = Date.now() + OPEN_RETRY_BUDGET_MS;
  const deadline =
    afterDeath === 'busy' && openDeadline !== undefined
      ? Math.max(idleDeadline, openDeadline)
      : idleDeadline;
  let waiting = false;
  for (;;) {
    try {
      return await sqlite.open_v2(file);
    } catch (error) {
      if (!isHeldElsewhere(lastError())) throw error;
      if (Date.now() >= deadline) {
        throw afterDeath === 'busy' ? new HeldByKilledStatement(file) : error;
      }
      if (!waiting) {
        waiting = true;
        onWait();
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
 * cache. A `tx.savepoint()` is only opened between messages, so it never sits
 * above it.
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
 * (`src/const/vfs.ts`) and nowhere else — the client validates against it and sends
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
  | Promise<{
      sqlite: SQLiteAPI;
      module: WASQLiteModule;
      db: number;
    }>
  | undefined;
/**
 * The client terminates this worker on its next reply, and Safari before
 * WebKit 321564@main (26.x, 27.0.x; WebKit bug 324094) keeps the connection of
 * a worker terminated before its last IndexedDB transaction completed — a
 * readonly one included — for the life of the browser process:
 * `indexedDB.deleteDatabase` and upgrades of that database then block, through
 * reloads. An IndexedDB VFS's `close()` closes its connection, which refuses
 * any new transaction, then waits for the live ones (wa-sqlite #384 and #385,
 * carried in patches/). Other VFS are left to the terminate. Bounded, as the
 * client waits for the reply.
 */
const IDB_CLOSE_MS = 2_000;
const closeIdbVfs = async (
  vfs: SQLiteVFS,
  instance: { close?: () => unknown } | undefined,
): Promise<void> => {
  if (VFS_CAPABILITIES[vfs].storage !== 'indexeddb' || !instance?.close) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.resolve()
      .then(() => instance.close?.())
      .catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, IDB_CLOSE_MS);
    }),
  ]);
  clearTimeout(timer);
};

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
  build: SQLiteBuild;
  wasm?: WasmLocation | undefined;
  pragmas?: Record<string, string> | undefined;
  statementCacheSize?: number | undefined;
  statementCacheBytes?: number | undefined;
  abortSlots?: SharedArrayBuffer | undefined;
  abortIndex?: number | undefined;
  declineWithout?: readonly PlatformFeature[] | undefined;
  probeFirst?: readonly PlatformFeature[] | undefined;
  afterDeath?: 'idle' | 'busy' | undefined;
  openDeadline?: number | undefined;
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

  const { vfs, build, wasm, pragmas = {}, abortSlots, abortIndex } = options;
  currentBuild = build;

  const slot =
    abortSlots && abortIndex !== undefined
      ? new Int32Array(abortSlots)
      : undefined;

  const vfsConfig = VFSConfigs[vfs];

  // Hoisted for the final `catch`. A failed `sqlite3_open_v2` says nothing
  // useful on its own: it used to name only the function, and since wa-sqlite
  // #330 it carries the connection's message, which is SQLite's generic
  // `unable to open database file`. Either way the real cause is the VFS's,
  // kept in `lastError` (spec 2026-09-13, §3.4). A fresh instance per open()
  // means the value cannot be stale.
  let vfsInstanceSeen:
    | { lastError?: unknown; close?: () => unknown }
    | undefined;

  // Each step announced as it begins, so an open that never finishes names
  // the step it stopped in (tests/browser/open-retry.test.ts).
  const boot = (stage: BootStage) =>
    self.postMessage({
      type: 'boot',
      callId: 0,
      stage,
    } satisfies WorkerMessageData);
  if (proceedGate) boot('waiting for the client');

  // Spec 2026-10-04, § 4: SQLite's authorizer refuses transaction control
  // unless the message carries the library's `control` flag. One query runs
  // at a time per worker, and a verdict between two of its chunks restores
  // what it changes, so plain variables cannot interleave.
  let allowControl = false;
  /** The SQL being prepared, so an allowed control statement is remembered. */
  let preparing: string | undefined;
  /**
   * Control statements the library ran, with their keyword. A cache hit
   * prepares nothing, so the authorizer never sees it: without this a
   * consumer's `BEGIN IMMEDIATE` would reuse the library's cached one.
   */
  const controlSql = new Map<string, string>();
  /** The keyword the authorizer last refused, for the message. */
  let denied: string | undefined;
  /**
   * True while a statement steps. What SQLite prepares then is its own: VACUUM
   * runs a BEGIN of its own during its step. A consumer's control statement is
   * refused at its own prepare, or by the `controlSql` check, before any step.
   */
  let stepping = false;
  /**
   * What the authorizer saw while the statement just prepared was. Taken, and
   * so emptied, as each statement arrives: the next prepare starts clean.
   */
  let seen: AuthorizerFacts = {};
  const takeSeen = (): AuthorizerFacts => {
    const facts = seen;
    seen = {};
    return facts;
  };
  /**
   * The same facts, kept per statement handle for as long as the statement is
   * cached: the authorizer does not run on a cache hit, as for `controlSql`.
   * An entry goes with its handle (eviction, failure, `drain`), so the map is bounded by the cache.
   */
  const factsOf = new Map<number, AuthorizerFacts>();
  /**
   * The text of a statement carrying `refuseWrite` while it steps. Its kind
   * was checked before the first step, but a cached statement whose schema
   * changed is re-prepared during the step and may become a write then
   * (`DROP TRIGGER IF EXISTS` once the trigger exists).
   */
  let guardingStep: string | undefined;
  /** The authorizer denied such a re-preparation: the step's error is a refusal. */
  let stepRefused = false;
  const authorize = (
    _: unknown,
    action: number,
    operation: string | null,
    argument: string | null,
  ): number => {
    // What SQLite re-prepares during a step is its own, not a new statement.
    if (!stepping) {
      if (action === SQLITE_PRAGMA)
        seen.pragma = { name: operation ?? '', value: argument ?? null };
      else if (action === SQLITE_ATTACH || action === SQLITE_DETACH)
        seen.attach = true;
    } else if (
      guardingStep !== undefined &&
      !(action === SQLITE_PRAGMA
        ? !pragmaWrites(
            pragmaIn(
              { name: operation ?? '', value: argument ?? null },
              guardingStep,
            ),
          )
        : READ_ACTIONS.has(action))
    ) {
      stepRefused = true;
      return SQLITE_DENY;
    }
    if (action !== SQLITE_TRANSACTION && action !== SQLITE_SAVEPOINT)
      return SQLITE_OK;
    const keyword =
      action === SQLITE_TRANSACTION
        ? (operation ?? 'BEGIN')
        : operation === 'BEGIN'
          ? 'SAVEPOINT'
          : operation === 'ROLLBACK'
            ? 'ROLLBACK TO'
            : 'RELEASE';
    if (allowControl) {
      if (preparing !== undefined) controlSql.set(preparing, keyword);
      return SQLITE_OK;
    }
    if (stepping) return SQLITE_OK;
    denied = keyword;
    return SQLITE_DENY;
  };

  openedDB = (proceedGate?.promise ?? Promise.resolve())
    .then(() => {
      boot('loading the build');
      return WA_SQLITE_BUILDS[build]();
    })
    .then(({ default: factory }) => {
      boot('instantiating wasm');
      return factory(wasmModuleArg(wasm));
    })
    .then((module) => {
      boot('loading the VFS module');
      const sqlite = SQLite.Factory(module);
      return vfsConfig.fs().then((vfsModule) => ({
        sqlite,
        module,
        vfsModule: (vfsModule as unknown as Record<string, VFSClass>)[vfs],
      }));
    })
    .then(({ sqlite, module, vfsModule }) => {
      boot('creating the VFS');
      return (
        createVfsInstance(vfsModule, vfs, module, () =>
          boot('waiting for a held file'),
        ) as Promise<any>
      ).then((vfsInstance: any) => {
        vfsInstanceSeen = vfsInstance;
        sqlite.vfs_register(vfsInstance, true);
        boot('waiting for the open lock');
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
          boot('opening the database');
          const db = await openWithRetry(
            sqlite,
            file,
            () => vfsInstanceSeen?.lastError,
            options.afterDeath,
            options.openDeadline,
            () => boot('waiting for a held file'),
          );
          boot('applying pragmas');
          for (const statement of renderPragmas(pragmas)) {
            for await (const stmt of sqlite.statements(db, statement)) {
              while ((await sqlite.step_asap(stmt)) === SQLITE_ROW) {}
            }
          }
          // After the pragmas, which are not control. A plain function: an
          // async one would take wa-sqlite's `_async` relay.
          sqlite.set_authorizer(db, authorize, null);
          return { sqlite, module, db };
        });
      });
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
        message:
          detail && !(error instanceof HeldByKilledStatement)
            ? `${base}: ${detail}`
            : base,
        cause: cloneable(detail ? vfsError : error),
        ...(sqliteCode !== undefined ? { sqliteCode } : {}),
      });
      throw error;
    });

  // Nothing awaits openedDB until a query arrives; keep a failed open from
  // becoming an unhandled rejection in the worker.
  openedDB.catch(() => {});

  const reply = (data: WorkerMessageData, transfer: Transferable[] = []) => {
    (
      self as unknown as {
        postMessage(data: WorkerMessageData, transfer: Transferable[]): void;
      }
    ).postMessage(data, transfer);
  };

  // One query at a time per worker (a worker holds one lease), so a single
  // counter cannot interleave. Reset by the `query` case, read by its reply.
  let prepared = 0;

  // Unlocked for the same reason: a second query would reset a statement the
  // first is stepping. `WORKER_BUSY` in pool.ts is what refuses one.
  const cache = createStatementCache({
    maxEntries: options.statementCacheSize ?? 0,
    maxBytes: options.statementCacheBytes ?? 0,
  });

  /**
   * One SQLite call sequence at a time in this worker: a query holds it from
   * its start to its reply except while it waits for a credit, a verdict for
   * its prepare-to-finalize. `sync` never interleaves the two; on
   * `async`/`jspi` a verdict would otherwise enter the module mid-call.
   */
  let sqliteHeld = false;
  const sqliteWaiters: (() => void)[] = [];
  /** `undefined` when free: the query's per-chunk take awaits nothing then. */
  const holdSqlite = (): Promise<void> | undefined => {
    if (!sqliteHeld) {
      sqliteHeld = true;
      return undefined;
    }
    return new Promise((resolve) => sqliteWaiters.push(resolve));
  };
  /** Hands the mutex to the next waiter, in arrival order. */
  const releaseSqlite = () => {
    const next = sqliteWaiters.shift();
    if (next) next();
    else sqliteHeld = false;
  };

  /** What both the query and the verdict do with a prepared statement. */
  const statementTools = (
    sqlite: SQLiteAPI,
    module: WASQLiteModule,
    db: number,
  ) => {
    /**
     * Read or write, from what SQLite reports about the prepared statement
     * and what the authorizer saw preparing it. Synchronous, runs nothing.
     */
    const kindOf = (stmt: number): StatementKind => {
      const seenFacts = factsOf.get(stmt);
      const pragma = seenFacts?.pragma
        ? pragmaIn(seenFacts.pragma, sqlite.sql(stmt))
        : undefined;
      return classifyStatement({
        ...seenFacts,
        ...(pragma ? { pragma } : {}),
        explain: module._sqlite3_stmt_isexplain(stmt) !== 0,
        readonly: module._sqlite3_stmt_readonly(stmt) !== 0,
      });
    };

    /** Finalises a handle and forgets what was kept for it. */
    const finalizeHandle = async (handle: number) => {
      factsOf.delete(handle);
      await sqlite.finalize(handle);
    };
    /**
     * Refuses a string holding more than one statement, from the statements
     * iterator after its first: a tail that yields a statement or an error is
     * a refusal, one that yields nothing is a single statement. Runs nothing.
     */
    const refuseMore = async (statements: AsyncIterator<number>) => {
      let more: boolean;
      try {
        const tail = await statements.next();
        if (!tail.done) await finalizeHandle(tail.value);
        more = !tail.done;
      } catch {
        more = true;
      }
      if (more) throw new MultipleStatements();
    };

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

    return { kindOf, finalizeHandle, refuseMore, stamped };
  };

  /** The refusal of a cached control statement: no SQLite call failed. */
  const cachedControlRefusal = (keyword: string) => {
    denied = keyword;
    // The connection's extended code is some earlier statement's: stamp it
    // here, `stamped` keeps the first.
    const refusal = new SQLite.SQLiteError('not authorized', SQLITE_AUTH);
    (refusal as { extendedCode?: number }).extendedCode = SQLITE_AUTH;
    return refusal;
  };

  /**
   * Prepares `sql`, classifies it and runs nothing; the caller holds the
   * mutex. The cache is read on a hit; on a miss the statement is filed only
   * where nothing can be using a cached one — no transaction open, no query
   * in flight — since an insertion can evict, and so finalise, a statement.
   */
  const verdictOf = async (sql: string): Promise<Verdict> => {
    if (!openedDB) throw new Error('No DB opened');
    const { sqlite, db, module } = await openedDB;
    if (closing) throw new Error('The SQLite client has been closed.');
    const { kindOf, finalizeHandle, refuseMore, stamped } = statementTools(
      sqlite,
      module,
      db,
    );
    const free = sqlite.get_autocommit(db) === 1;
    // In a transaction the answer must hold for the statement's own turn,
    // and a cached program predates the transaction's schema changes.
    const cached = free ? cache.get(sql) : undefined;
    if (typeof cached === 'number') {
      const keyword = controlSql.get(sql);
      if (keyword !== undefined) throw cachedControlRefusal(keyword);
      return kindOf(cached);
    }
    const keep = cached === undefined && queryRunning === undefined && free;
    const statements = sqlite
      .statements(db, sql, {
        unscoped: true,
        flags: keep ? SQLITE_PREPARE_PERSISTENT : 0,
      })
      [Symbol.asyncIterator]();
    let stmt: number | undefined;
    let file = false;
    try {
      const first = await statements.next();
      // Nothing to run, so nothing written.
      if (first.done) return 'read';
      stmt = first.value;
      factsOf.set(stmt, takeSeen());
      try {
        await refuseMore(statements);
      } catch (e) {
        if (e instanceof MultipleStatements) return 'refused';
        throw e;
      }
      file = keep;
      return kindOf(stmt);
    } catch (e) {
      throw stamped(e);
    } finally {
      if (stmt !== undefined) {
        if (file) {
          for (const handle of cache.set(sql, stmt, stmtWeight(module, stmt)))
            await finalizeHandle(handle);
        } else await finalizeHandle(stmt);
      }
      // Frees the SQL text wa-sqlite copied into wasm memory.
      await statements.return?.();
    }
  };

  const query = async function* (
    callId: number,
    sql: string,
    params: ParamsBlock | undefined,
    options?: SQLOptions,
    textOf?: () => string,
  ) {
    if (!openedDB) throw new Error('No DB opened');
    // Wasm allocations the statements' bindings point into, freed last.
    const owned: number[] = [];
    const { sqlite, db, module } = await openedDB;
    const { chunkSize = 1, refuseWrite, multi, drainWrites } = options ?? {};
    seen = {};
    const { kindOf, finalizeHandle, refuseMore, stamped } = statementTools(
      sqlite,
      module,
      db,
    );
    // sqlite3_changes() keeps the last write's count across a statement that
    // changes nothing; the total does not move then.
    const totalBefore = module._sqlite3_total_changes(db);

    // The size the query's previous chunk needed: the next one starts there.
    let chunkBytes = 0;

    /**
     * `refuseWrite`'s check, before the first step; its steps are guarded too
     * (`guardingStep`). An EXPLAIN runs no program, whatever it re-prepares.
     */
    const refuseWrites = (stmt: number, code: RefuseWrite) => {
      if (kindOf(stmt) === 'write') throw new WriteRefused(code);
      if (module._sqlite3_stmt_isexplain(stmt) === 0)
        guardingStep = sqlite.sql(stmt);
    };
    /** A step whose re-preparation the authorizer denied is a refused write. */
    const refusal = (e: unknown) =>
      stepRefused && refuseWrite ? new WriteRefused(refuseWrite) : e;

    /**
     * Binds and streams one statement. Never finalises: the caller owns it.
     * Returns whether it reached SQLITE_DONE. Nothing but the row loop goes
     * here: with `drainWrite`'s code in this generator, executed or not,
     * Firefox streams 6-16 % slower (ROUTING-DELTAS, `mem:measurements/routing`).
     */
    const rows = async function* (stmt: number, announce: boolean) {
      // Before the bindings and the first step, so nothing of it has run.
      if (refuseWrite) refuseWrites(stmt, refuseWrite);
      try {
        if (params) owned.push(bindBlock(module, sqlite, stmt, params));
      } catch (e) {
        throw stamped(e);
      }
      // A read streamed with `drainWrites` announces its count first.
      if (announce) yield new Affected(0, false);
      let finished = false;
      // Column names are read after the first SQLITE_ROW, not before: v2
      // re-preparation happens during step(), so names read beforehand would
      // describe the old schema on a cached statement after an ALTER TABLE.
      let cols: string[] | undefined;
      let writer: RowWriter | undefined;

      while (true) {
        if (gate.isStopped()) break;

        let result: number;
        try {
          stepping = true;
          // A number when nothing suspended; a synchronous throw lands in this
          // same `try`, like a rejection.
          const stepped = sqlite.step_asap(stmt);
          result = typeof stepped === 'number' ? stepped : await stepped;
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
        } finally {
          stepping = false;
        }
        if (gate.isStopped()) break;

        if (result === SQLITE_ROW) {
          cols ??= sqlite.column_names(stmt) as string[];
          writer ??= new RowWriter(chunkBytes);
          writer.row(module, stmt, cols.length);
          if (writer.rows >= chunkSize) {
            const block = writer.finish(cols);
            chunkBytes = block.used;
            writer = undefined;
            yield block;
          }
        } else {
          if (writer && cols) yield writer.finish(cols);
          finished = true;
          break;
        }
      }

      return finished;
    };

    /**
     * A write streamed with `drainWrites`, stepped to SQLITE_DONE first: its
     * chunks are kept here and sent once `affected` has gone out. Apart from
     * `rows`, see there.
     */
    const drainWrite = async function* (stmt: number) {
      const kept: RowsBlock[] = [];
      const source = rows(stmt, false);
      let step = await source.next();
      while (!step.done) {
        kept.push(step.value as RowsBlock);
        step = await source.next();
      }
      // A stop during the drain: nothing is sent. The write rolls back only
      // when the progress handler cut a step; a stop seen between steps, or on
      // the step that returned SQLITE_DONE, leaves a statement whose reset
      // halts it as a success, and in autocommit that commits.
      if (!step.value) return;
      yield new Affected(
        module._sqlite3_total_changes(db) === totalBefore
          ? 0
          : sqlite.changes(db),
        true,
      );
      // Under the credit gate, as any chunk; each let go once handed over.
      while (kept.length > 0) yield kept.shift() as RowsBlock;
    };

    /** Not a generator: a read takes no extra level of delegation. */
    const run = (stmt: number) =>
      !drainWrites
        ? rows(stmt, false)
        : kindOf(stmt) === 'write'
          ? drainWrite(stmt)
          : rows(stmt, true);

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
        await finalizeHandle(stmt);
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
          await finalizeHandle(stmt);
          return;
        }
        sqlite.clear_bindings(stmt);
      }
      for (const handle of cache.set(sql, stmt, stmtWeight(module, stmt))) {
        await finalizeHandle(handle);
      }
    };

    // Every statement gets the handler its build allows: the yielding one on
    // `async`/`jspi`, the slot poll on an isolated `sync`, none on a `sync`
    // without a slot.
    const yields = currentBuild !== 'sync';
    const polls = !yields && slot !== undefined;
    // The pool's own abort writes this statement's callId; its kill writes
    // KILLED_SLOT, because a terminated worker does not stop on Safari.
    const abortedHere = () => {
      if (slot === undefined) return false;
      const value = Atomics.load(slot, abortIndex as number);
      return value === callId || value === KILLED_SLOT;
    };
    if (yields || polls) {
      sqlite.progress_handler(
        db,
        PROGRESS_OPS,
        yields
          ? async () => {
              // The task turn is what lets a queued `stop` be delivered, and
              // what lets IDBBatchAtomicVFS's IndexedDB transaction commit.
              await gate.tick();
              return gate.isStopped() ? 1 : 0;
            }
          : () => (abortedHere() ? 1 : 0),
        null,
      );
    }
    preparing = options?.uncached ? undefined : sql;
    try {
      const cached = options?.uncached || multi ? undefined : cache.get(sql);

      if (typeof cached === 'number') {
        const keyword = controlSql.get(sql);
        if (keyword !== undefined && !allowControl)
          throw cachedControlRefusal(keyword);
        let failed = false;
        try {
          yield* run(cached);
        } catch (e) {
          // A denied re-preparation leaves no program fit to keep.
          failed = !(e instanceof WriteRefused);
          throw refusal(e);
        } finally {
          await settle(cached, failed);
        }
      } else if (multi) {
        // The barrier's own string: every statement runs in order, none is
        // kept. The generator finalises what it yields.
        for await (const stmt of sqlite.statements(
          db,
          textOf ? textOf() : sql,
        )) {
          prepared++;
          factsOf.set(stmt, takeSeen());
          try {
            yield* run(stmt);
          } finally {
            factsOf.delete(stmt);
          }
        }
      } else {
        // One statement, kept in the cache; or finalised after it when the
        // query is `uncached`.
        const keepIt = !options?.uncached;
        const statements = sqlite
          .statements(db, textOf ? textOf() : sql, {
            unscoped: true,
            flags: keepIt ? SQLITE_PREPARE_PERSISTENT : 0,
          })
          [Symbol.asyncIterator]();
        let stmt: number | undefined;
        let failed = false;
        try {
          const first = await statements.next();
          if (!first.done) {
            // Assigned BEFORE the rows are streamed: first() leaves the
            // generator early, and an assignment after `yield*` would never run.
            stmt = first.value;
            prepared++;
            // Before the tail is prepared, which the authorizer sees too.
            factsOf.set(stmt, takeSeen());
            await refuseMore(statements);
            yield* run(stmt);
          }
        } catch (e) {
          failed = !(e instanceof WriteRefused);
          throw stamped(refusal(e));
        } finally {
          if (stmt !== undefined) {
            if (keepIt) await settle(stmt, failed);
            else await finalizeHandle(stmt);
          }
          // Frees the SQL text wa-sqlite copied into wasm memory.
          await statements.return?.();
        }
      }

      yield module._sqlite3_total_changes(db) === totalBefore
        ? 0
        : sqlite.changes(db);
    } catch (e) {
      // Only the multi branch can still reach here unstamped: its
      // prepare failures come straight from wa-sqlite's own statements()
      // generator, with no catch of ours in between. Checked 2026-09-14 in
      // sqlite-api.js: between a failed prepare and the error leaving that
      // generator, it calls only sqlite3_errmsg (read-only) and sqlite3_free
      // (memory only) — neither touches sqlite3_extended_errcode(db). The
      // cached and single-statement branches already stamp in `run` and their own
      // inner catch, so `??=` makes this a no-op for those.
      throw stamped(e);
    } finally {
      preparing = undefined;
      guardingStep = undefined;
      stepRefused = false;
      if (yields || polls) sqlite.progress_handler(db, 0, () => 0, null);
      // After settle(): the bindings pointing into these are cleared.
      for (const p of owned) module._sqlite3_free(p);
    }
  };

  self.onmessage = async (event: MessageEvent<ClientMessageData>) => {
    const { data } = event;
    switch (data.type) {
      case 'query': {
        const { callId, sql, params, options } = data;
        // Reset the credit gate for this call before the mutex: a `stop` for
        // it may arrive while a verdict holds the mutex. pool.ts sets the
        // worker's status to RUNNING after posting the query.
        gate.reset(callId, options?.credits ?? DEFAULT_CREDIT_WINDOW);
        queryRunning = Promise.withResolvers<void>();
        const held = holdSqlite();
        if (held) await held;
        denied = undefined;
        allowControl = options?.control === true;
        try {
          prepared = 0;
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
              const own = allowControl;
              allowControl = true;
              try {
                for await (const _ of query(callId, statement, undefined)) {
                  // Savepoint statements return no rows.
                }
              } finally {
                allowControl = own;
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
              // one.
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

          // A patterned query is cached under (sql, pattern, rows): a cached
          // statement never builds its text, which is up to ~100 KB.
          const { pattern } = data;
          const rows = params?.rows ?? 0;
          let key = sql;
          let textOf: (() => string) | undefined;
          if (pattern !== undefined) {
            key = `${sql}\u0001${pattern}\u0001${rows}`;
            let text: string | undefined;
            textOf = () =>
              (text ??= sql + new Array(rows).fill(pattern).join(','));
          }

          for await (const chunk of query(
            callId,
            key,
            params,
            options,
            textOf,
          )) {
            if (typeof chunk === 'number') {
              affected = chunk;
              break;
            }
            // Ahead of the first chunk, outside the credit gate.
            if (chunk instanceof Affected) {
              reply({
                type: 'affected',
                callId,
                affected: chunk.affected,
                drained: chunk.drained,
              });
              continue;
            }
            // The mutex is let go while the query waits for its credit: no
            // SQLite call is in flight, and the consumer's next pull, which
            // sends the credit, may itself be waiting on a verdict.
            releaseSqlite();
            const taken = await gate.take(callId);
            const back = holdSqlite();
            if (back) await back;
            if (taken === 'stopped') break;
            reply({ type: 'chunk', callId, data: chunk }, [chunk.buffer]);
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
          if (denied !== undefined && sqliteCodeOf(e) === SQLITE_AUTH) {
            (e as Error).message = controlRefusedMessage(
              denied,
              await connectionInTransaction(),
            );
          }
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
          allowControl = false;
          queryRunning?.resolve();
          queryRunning = undefined;
          releaseSqlite();
        }
        break;
      }
      case 'verdict': {
        const { callId, sql } = data;
        const held = holdSqlite();
        if (held) await held;
        // A query waiting for a credit keeps its own; the verdict's prepare
        // is never control.
        const kept = { allowControl, preparing, denied, seen };
        allowControl = false;
        preparing = undefined;
        denied = undefined;
        seen = {};
        try {
          reply({ type: 'verdict', callId, kind: await verdictOf(sql) });
        } catch (e) {
          const sqliteCode = sqliteCodeOf(e);
          const message =
            denied !== undefined && sqliteCode === SQLITE_AUTH
              ? controlRefusedMessage(denied, await connectionInTransaction())
              : e instanceof Error
                ? e.message
                : `Unknown error (${e})`;
          const extendedCode = (e as { extendedCode?: unknown } | undefined)
            ?.extendedCode;
          reply({
            type: 'verdict-error',
            callId,
            message,
            ...(sqliteCode !== undefined ? { sqliteCode } : {}),
            ...(typeof extendedCode === 'number'
              ? { sqliteExtendedCode: extendedCode }
              : {}),
          });
        } finally {
          ({ allowControl, preparing, denied, seen } = kept);
          releaseSqlite();
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
        // A verdict may be mid-prepare.
        const held = holdSqlite();
        if (held) await held;
        try {
          // open() assigns openedDB before this loop runs; the throw is caught below.
          if (!openedDB) throw new Error('No DB opened');
          const { sqlite, db } = await openedDB;
          // SQLite refuses to close a connection carrying live statements,
          // and the catch below would swallow the SQLITE_BUSY. idleUntilQueryEnds
          // has already returned, so the in-flight query's statement is reset
          // and filed: nothing here is in use.
          for (const handle of cache.drain()) {
            await sqlite.finalize(handle);
          }
          factsOf.clear();
          await sqlite.close(db);
        } catch {
          // A database that never opened has nothing to close; the client is
          // shutting down either way and must still get its reply.
        } finally {
          releaseSqlite();
        }
        // sqlite.close returns before its VFS's last transaction completes.
        await closeIdbVfs(vfs, vfsInstanceSeen);
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
      // The client cut the transport and terminates on the answer, or after a
      // grace if this worker cannot answer (pool.ts). Nothing new may start:
      // the running statement fails, the client discards its result anyway.
      case 'quiesce': {
        gate.stop();
        await closeIdbVfs(vfs, vfsInstanceSeen);
        self.postMessage({ type: 'quiesced', callId: 0 });
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
 * Whether an OPFS entry exists at `path`. The presence test for a VFS with a
 * `folder`, where the database IS the file at that name — so the
 * file system answers directly, without going through a VFS whose open path
 * has conditions of its own.
 */
const opfsEntryExists = async (path: string): Promise<boolean> => {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return false;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }
    await dir.getFileHandle(name);
    return true;
  } catch (error) {
    if ((error as DOMException)?.name === 'NotFoundError') return false;
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
 * already perform internally. It runs for every VFS with a folder rather than
 * for an exception list, because it is idempotent and a list would be a second
 * place to update when a VFS is added.
 */
const deleteDatabaseFiles = async (data: {
  file: string;
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  wasm?: WasmLocation;
}): Promise<boolean> => {
  const { file, vfs, build, wasm } = data;

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
    () => {},
  )) as any;

  const { storage } = VFS_CAPABILITIES[vfs];
  // A folder is the declaration that the database IS the OPFS entry at its path.
  const byPath = folderOf(vfs) !== undefined;

  // Presence, and it is decided differently per storage.
  //
  // On a VFS with a `folder` the database IS the file at that name, so the entry answers
  // — and it has to, because an open probe cannot. SQLITE_CANTOPEN does NOT
  // mean "not there" on every VFS: OPFSCoopSyncVFS returns it for a file that
  // exists but is empty, because its jOpen only reaches a path recorded in
  // `accessiblePaths` and it records one only for a file with a size. A
  // database opened and never written was therefore reported absent (measured
  // 2026-09-18; `delete.test.ts` pins it). The same code comes back when the
  // file's exclusive handle is held by a context that has died, so reading it
  // as absence would also let a deletion silently skip a live database's files.
  //
  // Everywhere else the probe stands: open without SQLITE_OPEN_CREATE and read
  // SQLITE_CANTOPEN (14) as absence. Any other error is a genuine failure and
  // must not be swallowed as DATABASE_NOT_FOUND — a corrupt database returns
  // SQLITE_CORRUPT, and a WASM/VFS start-up failure throws before open_v2 is
  // reached at all.
  const sqlite = SQLite.Factory(module);
  sqlite.vfs_register(vfsInstance, true);
  if (byPath) {
    if (!(await opfsEntryExists(file))) {
      // Nothing to delete. Close the VFS instance and report absence — no
      // jDelete and no OPFS second pass, because those would operate on
      // files just confirmed to be absent.
      await vfsInstance.close?.();
      return false;
    }
  } else {
    try {
      const db = await sqlite.open_v2(file, SQLITE_OPEN_READWRITE);
      // Database exists; close the handle at once and proceed to deletion.
      // The same vfsInstance services both this probe and the jDelete calls
      // below, so no re-acquisition of OPFS access handles is needed.
      await sqlite.close(db);
    } catch (error: unknown) {
      // Closed on every outcome: the client terminates this worker on the
      // reply, and an IndexedDB VFS's close() waits for its transactions.
      await vfsInstance.close?.();
      if ((error as { code?: unknown })?.code === SQLITE_CANTOPEN) {
        return false;
      }
      throw error;
    }
  }

  try {
    // Not on a VFS with a folder: the OPFS pass below removes every file there,
    // after the VFS has closed, so jDelete adds nothing there — and OPFSWriteAheadVFS's
    // refuses anything but its own temporary files, logging an error per call
    // (three per deletion, on every engine; 2026-09-14). No test can see that
    // console: it belongs to the delete worker.
    if (!byPath) {
      // On AccessHandlePoolVFS each sibling also occupies its own pool slot.
      for (const suffix of DATABASE_FILE_SUFFIXES) {
        // Pass syncDir=1, not 0. IDBBatchAtomicVFS.jDelete (wa-sqlite
        // IDBBatchAtomicVFS.js:119-133) only awaits its IndexedDB transaction
        // when syncDir is truthy — with 0 the delete is queued on #chain but
        // the worker exits before it commits, leaving the data intact.
        // OPFSAdaptiveVFS, OPFSAnyContextVFS and IDBMirrorVFS honour the same
        // flag with `if (syncDir) await result`; the remaining VFS ignore it.
        await vfsInstance.jDelete(`${file}${suffix}`, 1);
      }
    }

    // Commit barrier for IndexedDB VFS. This call is a barrier, not a check —
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
    // IDBMirrorVFS (also IndexedDB) is inert here: its jAccess is a pure
    // in-memory map lookup that issues no IDB transaction (IDBMirrorVFS.js:
    // 239-253), so no serialisation barrier is created. That is harmless
    // because IDBMirrorVFS.#deleteFile already awaits oncomplete before
    // returning (IDBMirrorVFS.js:738-751).
    //
    // The gate is by storage declaration, not by VFS name, keeping with this
    // project's convention that VFS behaviour is declared once in
    // VFS_CAPABILITIES and never special-cased by name. A future IndexedDB VFS
    // inherits the barrier, which is either needed (like IDBBatchAtomicVFS) or
    // inert (like IDBMirrorVFS).
    if (storage === 'indexeddb') {
      const pResOut = new DataView(new ArrayBuffer(4));
      await vfsInstance.jAccess(`${file}`, 0, pResOut);
    }
  } finally {
    await vfsInstance.close?.();
  }

  if (byPath) {
    // Sidecars first, the main file (suffix '') last. If a sidecar removal
    // then failed while the main file went first, the file this VFS opens to
    // probe existence would already be gone: the next deleteDatabase answers
    // DATABASE_NOT_FOUND and nothing public can remove the sidecar left
    // behind. Removing the main file last means a failure here always still
    // leaves it in place, so a retried deleteDatabase finds the database and
    // tries again. No test can inject the failed removal this guards against.
    for (const suffix of [
      ...DATABASE_FILE_SUFFIXES.filter((suffix) => suffix !== ''),
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
        wasm,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
        abortSlots,
        abortIndex,
        declineWithout,
        probeFirst,
        afterDeath,
        openDeadline,
      } = data;
      open(file, {
        vfs,
        build,
        wasm,
        pragmas,
        statementCacheSize,
        statementCacheBytes,
        abortSlots,
        abortIndex,
        declineWithout,
        probeFirst,
        afterDeath,
        openDeadline,
      });
      break;
    }
    case 'delete': {
      // Every outcome is answered with terminate(): deleteDatabaseFiles closes
      // its VFS first, which waits for the jAccess barrier's readonly
      // transaction, among others, on an IndexedDB VFS.
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
    case 'query':
    case 'verdict': {
      // queries arrive only after open() replaces self.onmessage; this case
      // is unreachable at runtime but satisfies the exhaustive check.
      break;
    }
    case 'close': {
      // close arrived before open completed — no database to close; reply immediately.
      self.postMessage({ type: 'closed', callId: 0 });
      break;
    }
    // Unreachable as close is: open() replaces this handler first. Answered
    // all the same, as the open handler answers it.
    case 'quiesce': {
      self.postMessage({ type: 'quiesced', callId: 0 });
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
