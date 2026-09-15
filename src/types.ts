import type { SQLiteErrorCode } from './errors';
import type { SQLiteResultCode } from './sqlite-codes';

export type SQLiteWorkerMessageData<_T = unknown> = {
  callId: number;
  terminate?: boolean;
} & (
  | SQLWorkerResultData[keyof SQLWorkerResultData]
  | { type: 'error'; message: string }
);

export type SQLWorkerResultData<T = unknown> = {
  open: { success: boolean };
  sql: { type: 'partial'; result: T[] } | { type: 'one'; sizes: number[] };
  abort: { type: 'done' };
};

export const SharedArrayTypes = {
  INT: 0,
  STRING: 1,
  OBJECT: 2,
};

/**
 * The savepoint a transaction asks the worker to handle around one query
 * (spec 2026-09-11, D4/D5). `conclude` settles the savepoint the previous
 * savepointed write left open — `release` keeps that write, `undo` rolls it
 * back first — and `open` starts one for this query's own statement. Both run
 * before the statement, conclusion first. Internal: no consumer sets it.
 */
export type SavepointOp = { conclude?: 'release' | 'undo'; open?: true };

type SQLOptions = {
  chunkSize?: number;
  /** Chunks the worker may send before waiting for a credit. Spec §3.2. */
  credits?: number;
  /** When true, the worker installs an async progress handler so an AbortSignal can stop a running step(). */
  abortable?: boolean;
  /** See `SavepointOp`. */
  savepoint?: SavepointOp;
};

/**
 * Where a worker fetches its `.wasm` from, when the consumer overrode it.
 *
 * Discriminated rather than a single string because the two forms differ in
 * what they leave to the Emscripten glue. `base` is a directory: the glue
 * supplies the file name (`locateFile('wa-sqlite-async.wasm')`), so nothing
 * here names the three builds' files — and nothing has to be renamed when
 * wa-sqlite renames one. `file` is the whole URL, typically content-hashed by
 * a bundler, so the glue's file name is discarded.
 *
 * Always absolute: `resolveWasmLocation` (`src/utils.ts`) resolves against the
 * page before the `open` message is posted, so the worker applies it without
 * knowing what it was relative to.
 */
export type WasmLocation = { base: string } | { file: string };

export type ClientMessageData =
  | {
      type: 'open';
      file: string;
      vfs: SQLiteVFS;
      build?: SQLiteBuild;
      pragmas?: Record<string, string>;
      /** Statements retained per worker; see `src/client.ts`. Internal. */
      statementCacheSize?: number;
      /** Bytes retained per worker; see `src/client.ts`. Internal. */
      statementCacheBytes?: number;
      wasm?: WasmLocation;
      /** Shared abort slots, one Int32 per worker. Isolated contexts only. */
      abortSlots?: SharedArrayBuffer;
      /** This worker's index into `abortSlots`. */
      abortIndex?: number;
      /**
       * Features this worker must find before opening; it declines instead of
       * opening when one is missing (spec 2026-09-13). Sent to slots of index
       * ≥ 1 only, and only by a VFS that declares `singleConnectionWithout`.
       */
      declineWithout?: readonly PlatformFeature[];
    }
  | {
      type: 'query';
      callId: number;
      sql: string;
      params: unknown[];
      options?: SQLOptions;
    }
  | { type: 'close'; callId: number }
  | { type: 'credit'; callId: number; n: number }
  | { type: 'stop'; callId: number }
  | {
      type: 'delete';
      callId: number;
      file: string;
      vfs: SQLiteVFS;
      build?: SQLiteBuild;
      wasm?: WasmLocation;
    };

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  /**
   * The worker found a feature of `declineWithout` missing and opened nothing:
   * the environment caps the pool (spec 2026-09-13).
   */
  | { type: 'declined'; callId: number; missing: PlatformFeature }
  | { type: 'chunk'; callId: number; data: unknown[] }
  | {
      type: 'done';
      callId: number;
      affected: number;
      /**
       * Statements compiled while serving this query — zero on a cache hit.
       * Rides the same message as `affected` rather than opening a channel:
       * the effect this instruments is a count, not a duration (`mem:lessons`,
       * "for a sub-millisecond effect, count the round trips").
       */
      prepared: number;
      /**
       * Whether the connection is inside a transaction once this query has
       * ended — `sqlite3_get_autocommit() === 0`. SQLite can leave a
       * transaction by itself: an interrupted INSERT/UPDATE/DELETE rolls the
       * whole transaction back. Absent when the worker could not read it.
       */
      inTransaction?: boolean | undefined;
    }
  | {
      type: 'error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: SQLiteResultCode;
      /**
       * SQLite's extended result code, read in the worker where the statement
       * failed (spec 2026-09-14, §5.1). Sent by the query path only, and
       * unfiltered: this is exactly what SQLite reported, including a value
       * equal to `sqliteCode` (no subtype). The client is what drops it in
       * that case (D9); when SQLite does report a subtype,
       * `(sqliteExtendedCode & 0xff) === sqliteCode`.
       */
      sqliteExtendedCode?: number;
      /**
       * A code this library minted, when the worker knows the cause. The
       * generic path by which a worker-side error keeps its code across the
       * boundary — `worker.ts` copies it off any thrown error carrying one, so
       * this is a structural contract and not a hook for one class.
       *
       * **Nothing sets it today.** `WorkerQueryTimeout` was its only producer
       * and it went with the execution budget when `timeout` became a
       * client-side wall-clock deadline. Kept rather than deleted: it is the
       * twin of `sqliteCode` above, which is load-bearing, and rebuilding it
       * would cost the same three sites it occupies.
       */
      errorCode?: SQLiteErrorCode;
      /**
       * Whether the connection is inside a transaction once this query has
       * ended — `sqlite3_get_autocommit() === 0`. SQLite can leave a
       * transaction by itself: an interrupted INSERT/UPDATE/DELETE rolls the
       * whole transaction back. Absent when the worker could not read it.
       */
      inTransaction?: boolean | undefined;
    }
  | { type: 'closed'; callId: number }
  | { type: 'deleted'; callId: number }
  /** The delete worker found nothing at that name; deleteDatabase turns it into DATABASE_NOT_FOUND. */
  | { type: 'not-found' }
  | {
      type: 'open-error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: SQLiteResultCode;
    };

/** Which wa-sqlite WebAssembly build a worker loads. */
export type SQLiteBuild = 'sync' | 'async' | 'jspi';

/**
 * What each build needs from the engine beyond plain WebAssembly.
 *
 * `satisfies Record<SQLiteBuild, …>` and not `SQLiteBuild = keyof typeof …`:
 * the check must run in this direction. Adding a build to the union then fails
 * to compile until its requirements are declared, where `keyof` would let a
 * forgotten entry mean silently that the build does not exist. `VFS_CAPABILITIES`
 * derives `SQLiteVFS` from its keys because it *is* the VFS registry; the build
 * registry is `WA_SQLITE_BUILDS` in the worker, and this table describes one
 * attribute of builds rather than the builds themselves.
 */
export const BUILD_REQUIREMENTS = {
  sync: [],
  async: [],
  jspi: ['jspi'],
} as const satisfies Record<SQLiteBuild, readonly PlatformFeature[]>;

/**
 * Platform features a build USES when present and works without, at a cost —
 * the symmetric of `degradesWithout` on a VFS, at the level where this one
 * actually lives. The `sync` build cannot carry an abort into a running
 * `step()` without a `SharedArrayBuffer`, and there is no SharedArrayBuffer
 * outside a cross-origin isolated context: measured 2026-09-04, it is not
 * restricted there, it is absent. Nothing here names COOP/COEP or
 * Document-Isolation-Policy: any of them satisfies the probe, and one of them
 * is Chrome-only.
 */
export const BUILD_DEGRADES_WITHOUT = {
  sync: ['cross-origin-isolated'],
  async: [],
  jspi: [],
} as const satisfies Record<SQLiteBuild, readonly PlatformFeature[]>;

/**
 * A platform feature a VFS may need. Which browser versions ship each one is
 * documentation data, not runtime data, so it lives in the VFS.md generator
 * (`scripts/render-vfs-matrix.ts`) with its sources — not here, where it would
 * ship to every consumer for nothing.
 */
export type PlatformFeature =
  | 'opfs'
  | 'readwrite-unsafe'
  | 'jspi'
  | 'writable-stream'
  | 'cross-origin-isolated';

/** Where a VFS keeps the database. */
export type VFSStorage = 'opfs' | 'indexeddb' | 'memory';

/**
 * How a VFS arranges a database in its storage — which is not the same
 * question as `storage`, and cannot be derived from it: `AccessHandlePoolVFS`
 * is `storage: 'opfs'` yet keeps opaque, randomly named slot files whose
 * association with a SQLite path lives in a header inside each file.
 *
 * `deleteDatabase` reads this to decide whether the database is also an OPFS
 * entry it can remove by name after `jDelete` — the pass that covers the two
 * VFS whose `jDelete` does not delete. A wrong value here is a deletion that
 * reports success over an intact file.
 */
export type VFSLayout = 'opfs-path' | 'opfs-pool' | 'idb-store' | 'memory';

/** How much of the database a VFS keeps resident in RAM. */
export type VFSMemoryModel = 'page-cache' | 'whole-database';

/** What a VFS can and cannot do. One entry per VFS, and no second table. */
export type VFSCapability = {
  /** Builds this VFS can run on, most preferred first. */
  readonly builds: readonly [SQLiteBuild, ...SQLiteBuild[]];
  /** Largest pool this VFS supports; `null` when unbounded. */
  readonly maxPoolSize: number | null;
  /** Why the cap exists. Required whenever `maxPoolSize` is not null. */
  readonly poolLimitReason: string | null;
  /** Whether several connections may share one database. */
  readonly multiConnection: boolean;
  /** Whether data outlives `close()`. */
  readonly persistent: boolean;
  /**
   * `page-cache`: only SQLite's page cache is resident, bounded by
   * `PRAGMA cache_size`. `whole-database`: the entire database is resident,
   * and `poolSize` multiplies it.
   */
  readonly memoryModel: VFSMemoryModel;
  /** Where the database actually lives. */
  readonly storage: VFSStorage;
  /** How the database is arranged within that storage. */
  readonly layout: VFSLayout;
  /**
   * Platform features without which this VFS cannot work at all.
   *
   * `readwrite-unsafe` is the one that bites: WebIDL ignores the unknown
   * dictionary member on engines that do not implement it, so the handle
   * silently opens exclusive, and a second connection then waits or fails
   * depending on the VFS — see `degradesWithout` and `singleConnectionWithout`.
   * Declaring it is what lets the conformance suite probe for it and skip,
   * instead of leaving it to surface as a 60-second timeout.
   */
  readonly requires: readonly PlatformFeature[];
  /**
   * Platform features this VFS uses when present and works without, at a cost.
   *
   * `OPFSAdaptiveVFS` is the case this field exists for. Without
   * `readwrite-unsafe` it rotates a single exclusive access handle between
   * connections instead of holding one each. That works — Firefox is the engine
   * the browser suite exercises it on — but a connection in a long
   * uninterruptible statement holds the handle, and every other connection to
   * the database, in another client or tab, waits for it. Within one client it
   * runs a single worker there: see `singleConnectionWithout`.
   *
   * Without this distinction, a support table derived from browser specs would
   * mark that VFS broken everywhere outside Chromium, when it merely degrades.
   */
  readonly degradesWithout: readonly PlatformFeature[];
  /**
   * Platform features without which a pool of more than one worker buys this
   * VFS nothing, so it runs on one (spec 2026-09-13, §3 and §10). Either the
   * VFS holds its database file exclusively for a connection's whole life and
   * a second worker cannot open at all (`OPFSWriteAheadVFS`), or it rotates one
   * exclusive access handle between connections and a second worker only waits
   * its turn (`OPFSAdaptiveVFS` — measured 2026-09-14 on Firefox: a pool of one
   * was faster at startup and on bursts of reads, and equal everywhere else).
   * The pool's surplus workers probe the feature before loading anything and
   * decline (`src/worker/probes.ts`); every feature listed needs a probe there.
   */
  readonly singleConnectionWithout: readonly PlatformFeature[];
  /**
   * Files this VFS keeps beside the database, by suffix, beyond the three every
   * layout may have (`''`, `-journal`, `-wal`). `deleteDatabase` removes them
   * with the rest; a file missing from this list outlives its database.
   *
   * `OPFSWriteAheadVFS` keeps its write-ahead log in two files of its own,
   * `-wa0` and `-wa1` (wa-sqlite's `#getWriteAheadNameFromDbName`) — measured
   * left behind by every deletion until 2026-09-14.
   */
  readonly extraFileSuffixes: readonly string[];
  /**
   * Whether every statement on this VFS must hand its worker back to the event
   * loop while it runs, abortable or not.
   *
   * `IDBBatchAtomicVFS` is why it exists. Its `jLock` opens a readwrite
   * IndexedDB transaction on reaching SHARED, and IndexedDB commits a
   * transaction only once its thread returns to the event loop. A worker inside
   * one long statement never did, so every other connection's read queued
   * behind it until the statement ended — measured 2026-09-14 on both engines
   * (`mem:measurements`, IDB-SIGNAL). The worker then runs its progress handler
   * on every statement, a task turn every `PROGRESS_OPS` VM ops, which measured
   * no cost. The `sync` build cannot yield and ignores it.
   */
  readonly yieldsDuringStatements: boolean;
  /**
   * PRAGMAs this library applies on open for this VFS.
   *
   * Merged UNDER the consumer's `pragmas`, so any key they set wins and they
   * never lose a default by setting an unrelated one — `foreign_keys` is the
   * common case, and replacing rather than merging would silently disable
   * everything below it.
   *
   * The bar is deliberately high, and almost nothing clears it: **more
   * performance without less reliability, sourced rather than guessed.** Three
   * things were weighed and rejected. `journal_mode=wal` universally, because
   * no VFS here implements `xShmMap` and upstream gives write-ahead logging to
   * `OPFSWriteAheadVFS` alone, inside the VFS and unreachable by pragma.
   * `synchronous=normal`, because relaxing durability spends the consumer's
   * data, not their milliseconds. And `cache_size`, because raising it changes
   * a mode without a measurable gain — Firefox showed none at all, and the
   * heap it can then reach is never given back (measured 2026-09-02).
   */
  readonly defaultPragmas: Readonly<Record<string, string>>;
  /**
   * Whether this VFS enforces an origin-wide exclusive connection lock for the
   * client's lifetime.
   *
   * When `true`, `createSQLiteClient` acquires a `bsq:conn:…` Web Lock on first
   * use. A second client that attempts to open the same database receives `DATABASE_IN_USE`
   * immediately on its first query instead of silently reading a frozen, broken
   * view. This field is the only thing standing between a consumer and an
   * unfalsifiable silent failure — `SELECT 1` and even
   * `SELECT count(*) FROM sqlite_master` pass on a broken second client.
   *
   * `true` only for `AccessHandlePoolVFS`, whose OPFS access-handle pool is not
   * sharable across connections (measured AHP-2TAB, 2026-09-01).
   * `false` for `IDBMirrorVFS` — despite `multiConnection: false` — because two
   * clients on that VFS DO share data over its origin-wide `BroadcastChannel`
   * (measured 2026-09-01, 3/3 both engines). `multiConnection: false` there marks
   * concurrent-writer unsafety, not isolation.
   * `false` for the memory VFS, which are isolated by construction and have
   * nothing to exclude.
   *
   * `VFS_CAPABILITIES` is the single source of truth the client guard, the
   * conformance suite, the VFS.md generator and the benchmark page all read.
   * The gate is by this declaration, not by VFS name.
   */
  readonly exclusiveConnection: boolean;
  /**
   * Platform features without which this VFS holds its database file
   * exclusively for a connection's whole life, across the origin — so the
   * client takes `bsq:conn` exclusively, as for `exclusiveConnection`, and a
   * second client gets `DATABASE_IN_USE` (spec 2026-09-15).
   *
   * `OPFSWriteAheadVFS` without `readwrite-unsafe`: upstream's VFS requires the
   * mode and keeps its three access handles for the connection's life, so
   * nothing else can open the file — every query of a second client failed
   * with WORKER_CRASHED on Firefox, 20/20 per shape (2026-09-15).
   *
   * The page cannot probe these features, so worker 0 probes them before
   * opening (`src/worker/probes.ts`): every feature listed needs a probe there,
   * and must also be in `singleConnectionWithout`, whose surplus workers
   * decline before they touch the file.
   */
  readonly exclusiveConnectionWithout: readonly PlatformFeature[];
};

/**
 * The single source of truth for VFS selection. `SQLiteVFS` is derived from its
 * keys, `worker/worker.ts` must supply a loader for every key, the guards in
 * `client.ts` read it, the conformance suite gates its scenarios on it, and the
 * VFS.md table is generated from it. Nothing may hold a second copy.
 *
 * Build order is a decision per VFS, not a rule: `sync` is both the fastest and
 * the most portable build, so it leads wherever supported; `OPFSAdaptiveVFS`
 * cannot use it and leads with `async` because `jspi` is Chromium-only.
 *
 * Every declared build combination is verified by running it against the pinned
 * wa-sqlite v1.1.2, never copied from upstream's table.
 */
export const VFS_CAPABILITIES = {
  OPFSWriteAheadVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-path',
    // Measured on Firefox 2026-08-27, HAS_UNSAFE_HANDLES false: all three
    // build pairs and all six invariants pass. That campaign ran at an
    // EFFECTIVE pool of one: without readwrite-unsafe every worker but the
    // first failed to open, and conformance did not count live workers
    // (spec 2026-09-13). `requires` used to name readwrite-unsafe, which made
    // the conformance suite skip the very pairs that would have falsified it.
    // Safari behaves as Firefox — observed 2026-09-13, InvalidStateError.
    requires: ['opfs'],
    degradesWithout: ['readwrite-unsafe'],
    singleConnectionWithout: ['readwrite-unsafe'],
    extraFileSuffixes: ['-wa0', '-wa1'],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: ['readwrite-unsafe'],
    defaultPragmas: {},
  },
  OPFSAdaptiveVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-path',
    requires: ['opfs'],
    degradesWithout: ['readwrite-unsafe'],
    singleConnectionWithout: ['readwrite-unsafe'],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'async', 'jspi'],
    // Capped on every engine (spec 2026-09-13, §10, D9): a pool of one was faster at startup and on bursts of reads, equal elsewhere, on Chromium and Firefox (POOL-SIZE, 2026-09-14). The handle still rotates between clients and tabs, which is why the COOPSYNC-BUSY retry stays.
    maxPoolSize: 1,
    poolLimitReason:
      'it rotates one exclusive access handle between connections, so another worker only waits its turn',
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-path',
    requires: ['opfs'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  AccessHandlePoolVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason: 'it cannot share access handles between connections',
    multiConnection: false,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-pool',
    requires: ['opfs'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    // Two clients on one database break each other silently (AHP-2TAB,
    // 2026-09-01): the second resolves SELECT 1 but cannot read any table. An
    // origin-wide connection lock ensures the second client fails fast with
    // BUSY instead of appearing healthy and being useless.
    exclusiveConnection: true,
    exclusiveConnectionWithout: [],
    // The one VFS that clears the bar for a default. Upstream: "there is no
    // drawback to using PRAGMA locking_mode=exclusive" here, because this VFS
    // does not allow multiple connections anyway — and exclusive locking is
    // what lets SQLite use its own WAL without shared memory, which no VFS in
    // this set provides. Measured 2026-09-02 on both engines: ~4.7x faster on
    // 200 single-statement transactions (Chromium 4.2 -> 0.9 ms/write, Firefox
    // 2.0 -> 0.5), with the access-handle pool holding the same five databases
    // either way — SQLite removes the -wal on a clean close, so it costs no
    // slot at rest. `mem:measurements`.
    defaultPragmas: { locking_mode: 'exclusive', journal_mode: 'wal' },
  },
  IDBBatchAtomicVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'indexeddb',
    layout: 'idb-store',
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: true,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  IDBMirrorVFS: {
    builds: ['async', 'jspi'],
    // Measured 2026-08-25, not inferred: `CREATE TABLE` → `INSERT` → `SELECT`
    // at poolSize 2, 300 rounds under a loaded suite, failed 5 times — with
    // `no such table` (a connection not seeing a committed statement) and
    // `database is locked`. Nothing at all in 60 rounds unloaded, which is why
    // four sightings over two days never reproduced on demand. See MIRROR-1 in
    // mem:follow-ups for the method.
    //
    // It mirrors the whole database in memory PER WORKER and propagates
    // commits over BroadcastChannel, asynchronously — so a pool holds copies
    // that diverge, the same shape that had OPFSPermutedVFS removed from this
    // library. The commit barrier cannot rescue it: its prelude refreshes page
    // 1 through a real read transaction, and there is nothing fresher to read
    // on a connection whose mirror has not received the broadcast yet.
    maxPoolSize: 1,
    poolLimitReason:
      'its pages are mirrored per worker and commits propagate asynchronously, so a larger pool reads stale data or fails outright',
    multiConnection: false,
    persistent: true,
    // Upstream: "keeps all files in memory, persisting database files to
    // IndexedDB", and the whole database must fit in available memory.
    memoryModel: 'whole-database',
    storage: 'indexeddb',
    layout: 'idb-store',
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    // `multiConnection: false` marks concurrent-writer unsafety (MIRROR-1),
    // not isolation. Two clients share data over BroadcastChannel (measured
    // 2026-09-01, 3/3 both engines), so no exclusive lock is needed or correct.
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  OPFSAnyContextVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-path',
    requires: ['opfs', 'writable-stream'],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  MemoryVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    storage: 'memory',
    layout: 'memory',
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
  MemoryAsyncVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    storage: 'memory',
    layout: 'memory',
    requires: [],
    degradesWithout: [],
    singleConnectionWithout: [],
    extraFileSuffixes: [],
    yieldsDuringStatements: false,
    exclusiveConnection: false,
    exclusiveConnectionWithout: [],
    defaultPragmas: {},
  },
} as const satisfies Record<string, VFSCapability>;

export type SQLiteVFS = keyof typeof VFS_CAPABILITIES;

/** The build used when the caller does not name one. */
export const defaultBuildFor = (vfs: SQLiteVFS): SQLiteBuild =>
  VFS_CAPABILITIES[vfs].builds[0];
