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

type SQLOptions = {
  chunkSize?: number;
  /** Chunks the worker may send before waiting for a credit. Spec §3.2. */
  credits?: number;
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
      wasm?: WasmLocation;
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
    }
  | {
      type: 'error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: number;
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
      sqliteCode?: number;
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
 * A platform feature a VFS may need. Which browser versions ship each one is
 * documentation data, not runtime data, so it lives in the README generator
 * (`scripts/render-vfs-matrix.ts`) with its sources — not here, where it would
 * ship to every consumer for nothing.
 */
export type PlatformFeature =
  | 'opfs'
  | 'readwrite-unsafe'
  | 'jspi'
  | 'writable-stream';

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
   * silently opens exclusive and the second connection hangs rather than
   * failing. Declaring it is what lets the conformance suite probe for it and
   * skip, instead of leaving it to surface as a 60-second timeout.
   */
  readonly requires: readonly PlatformFeature[];
  /**
   * Platform features this VFS uses when present and works without, at a cost.
   *
   * `OPFSAdaptiveVFS` is the case this field exists for. Without
   * `readwrite-unsafe` it rotates a single exclusive access handle between
   * connections instead of holding one each. That works — 102 of 104 browser
   * tests pass on Firefox — but it serializes the whole pool for the duration
   * of a long uninterruptible statement.
   *
   * Without this distinction, a support table derived from browser specs would
   * mark that VFS broken everywhere outside Chromium, when it merely degrades.
   */
  readonly degradesWithout: readonly PlatformFeature[];
  /**
   * Whether this VFS enforces an origin-wide exclusive connection lock for the
   * client's lifetime.
   *
   * When `true`, `createSQLiteClient` acquires a `bsq:conn:…` Web Lock on first
   * use. A second client that attempts to open the same database receives `BUSY`
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
   * conformance suite, the README generator and the benchmark page all read.
   * The gate is by this declaration, not by VFS name.
   */
  readonly exclusiveConnection: boolean;
};

/**
 * The single source of truth for VFS selection. `SQLiteVFS` is derived from its
 * keys, `worker/worker.ts` must supply a loader for every key, the guards in
 * `client.ts` read it, the conformance suite gates its scenarios on it, and the
 * README table is generated from it. Nothing may hold a second copy.
 *
 * Build order is a decision per VFS, not a rule: `sync` is both the fastest and
 * the most portable build, so it leads wherever supported; `OPFSAdaptiveVFS`
 * cannot use it and leads with `async` because `jspi` is Chromium-only.
 *
 * Every declared build combination is verified by running it against the pinned
 * wa-sqlite v1.1.2, never copied from upstream's table.
 */
export const VFS_CAPABILITIES = {
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
    exclusiveConnection: false,
  },
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
    // build pairs and all six invariants pass, concurrent writes included, at
    // poolSize 1, 2 and 4. `requires` used to name readwrite-unsafe, which made
    // the conformance suite skip the very pairs that would have falsified it.
    // Safari is still unmeasured for this VFS — see `mem:follow-ups`.
    requires: ['opfs'],
    degradesWithout: ['readwrite-unsafe'],
    exclusiveConnection: false,
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    layout: 'opfs-path',
    requires: ['opfs'],
    degradesWithout: [],
    exclusiveConnection: false,
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
    // Two clients on one database break each other silently (AHP-2TAB,
    // 2026-09-01): the second resolves SELECT 1 but cannot read any table. An
    // origin-wide connection lock ensures the second client fails fast with
    // BUSY instead of appearing healthy and being useless.
    exclusiveConnection: true,
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
    exclusiveConnection: false,
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
    // `multiConnection: false` marks concurrent-writer unsafety (MIRROR-1),
    // not isolation. Two clients share data over BroadcastChannel (measured
    // 2026-09-01, 3/3 both engines), so no exclusive lock is needed or correct.
    exclusiveConnection: false,
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
    exclusiveConnection: false,
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
    exclusiveConnection: false,
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
    exclusiveConnection: false,
  },
} as const satisfies Record<string, VFSCapability>;

export type SQLiteVFS = keyof typeof VFS_CAPABILITIES;

/** The build used when the caller does not name one. */
export const defaultBuildFor = (vfs: SQLiteVFS): SQLiteBuild =>
  VFS_CAPABILITIES[vfs].builds[0];

/**
 * The VFS this project recommends when a caller has no reason to choose
 * another. It is NOT a default — `vfs` is required, precisely so that the name
 * lives in the consumer's own source and cannot move underneath their data.
 *
 * It lives here, beside the table, because the README generator marks this row
 * `(recommended)` and would otherwise hold a second copy. It is deliberately
 * not exported: a consumer writing `vfs: RECOMMENDED_VFS` would be exposed to
 * the same displacement the day the recommendation changes.
 */
export const RECOMMENDED_VFS: SQLiteVFS = 'OPFSAdaptiveVFS';
