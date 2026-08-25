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

export type ClientMessageData =
  | {
      type: 'open';
      file: string;
      vfs?: SQLiteVFS;
      build?: SQLiteBuild;
      pragmas?: Record<string, string>;
    }
  | {
      type: 'query';
      callId: number;
      sql: string;
      params: any[];
      options?: SQLOptions;
    }
  | { type: 'close'; callId: number }
  | { type: 'credit'; callId: number; n: number }
  | { type: 'stop'; callId: number };

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  | { type: 'chunk'; callId: number; data: any[] }
  | { type: 'done'; callId: number; affected: number }
  | {
      type: 'error';
      callId: number;
      message: string;
      cause?: unknown;
      /** SQLite's numeric result code, when the failure came from SQLite. */
      sqliteCode?: number;
    }
  | { type: 'closed'; callId: number }
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
 * A platform feature a VFS may need. Which browser versions ship each one is
 * documentation data, not runtime data, so it lives in the README generator
 * (`scripts/render-vfs-matrix.ts`) with its sources — not here, where it would
 * ship to every consumer for nothing.
 */
export type PlatformFeature = 'opfs' | 'readwrite-unsafe' | 'jspi';

/** Where a VFS keeps the database. */
export type VFSStorage = 'opfs' | 'indexeddb' | 'memory';

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
    requires: ['opfs'],
    degradesWithout: ['readwrite-unsafe'],
  },
  OPFSWriteAheadVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    requires: ['opfs', 'readwrite-unsafe'],
    degradesWithout: [],
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    requires: ['opfs'],
    degradesWithout: [],
  },
  AccessHandlePoolVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason: 'it cannot share access handles between connections',
    multiConnection: false,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    requires: ['opfs'],
    degradesWithout: [],
  },
  IDBBatchAtomicVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'indexeddb',
    requires: [],
    degradesWithout: [],
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
    requires: [],
    degradesWithout: [],
  },
  OPFSAnyContextVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    storage: 'opfs',
    requires: ['opfs'],
    degradesWithout: [],
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
    requires: [],
    degradesWithout: [],
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
    requires: [],
    degradesWithout: [],
  },
} as const satisfies Record<string, VFSCapability>;

export type SQLiteVFS = keyof typeof VFS_CAPABILITIES;

/** The build used when the caller does not name one. */
export const defaultBuildFor = (vfs: SQLiteVFS): SQLiteBuild =>
  VFS_CAPABILITIES[vfs].builds[0];

/**
 * The VFS used when the caller does not name one. It lives here, beside the
 * table, because the README generator marks this row `(default)` and would
 * otherwise hold a second copy — a copy the CI drift check cannot catch, since
 * changing the default in client.ts alone leaves the rendered table identical.
 */
export const DEFAULT_VFS: SQLiteVFS = 'OPFSAdaptiveVFS';

/**
 * Options accepted by query methods.
 *
 * `chunkSize` controls the number of rows per chunk and is only meaningful for
 * `read()` and `chunk()`. Other methods (`write`, `stream`, `first`) omit it
 * from their signatures so callers cannot set a field that would be silently
 * ignored.
 */
export type SQLiteQueryOptions<_T extends Record<string, unknown>> = {
  id?: string;
  chunkSize?: number;
  signal?: AbortSignal;
  debug?: string;
};
