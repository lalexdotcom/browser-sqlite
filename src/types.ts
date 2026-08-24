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
  /**
   * Whether this VFS opens access handles with `mode: 'readwrite-unsafe'`
   * with no fallback. WebIDL ignores the unknown member on engines that do
   * not implement it, so the handle silently opens exclusive and the second
   * connection hangs rather than failing — which is why this is declared and
   * probed rather than left to surface as a timeout.
   */
  readonly requiresUnsafeHandles: boolean;
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
    requiresUnsafeHandles: false,
  },
  OPFSWriteAheadVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    requiresUnsafeHandles: true,
  },
  OPFSCoopSyncVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    requiresUnsafeHandles: false,
  },
  AccessHandlePoolVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason: 'it cannot share access handles between connections',
    multiConnection: false,
    persistent: true,
    memoryModel: 'page-cache',
    requiresUnsafeHandles: false,
  },
  IDBBatchAtomicVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    requiresUnsafeHandles: false,
  },
  IDBMirrorVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    // Upstream: "keeps all files in memory, persisting database files to
    // IndexedDB", and the whole database must fit in available memory.
    memoryModel: 'whole-database',
    requiresUnsafeHandles: false,
  },
  OPFSAnyContextVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: null,
    poolLimitReason: null,
    multiConnection: true,
    persistent: true,
    memoryModel: 'page-cache',
    requiresUnsafeHandles: false,
  },
  MemoryVFS: {
    builds: ['sync', 'async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    requiresUnsafeHandles: false,
  },
  MemoryAsyncVFS: {
    builds: ['async', 'jspi'],
    maxPoolSize: 1,
    poolLimitReason:
      'its pages live in the worker that opened them, so a larger pool would open independent databases that diverge silently',
    multiConnection: false,
    persistent: false,
    memoryModel: 'whole-database',
    requiresUnsafeHandles: false,
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
