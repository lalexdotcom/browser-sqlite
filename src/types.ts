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
 * The single source of truth for VFS selection: which builds each VFS can run
 * on, most preferred first. `SQLiteVFS` is derived from its keys, and
 * `worker/worker.ts` must supply a loader for every key — so a VFS cannot be
 * added in one place and forgotten in the other.
 *
 * Order is a decision per VFS, not a rule. `sync` is both the fastest and the
 * most portable build, so it leads wherever it is supported; `OPFSAdaptiveVFS`
 * cannot use it and leads with `async` because `jspi` is Chromium-only.
 *
 * Source: wa-sqlite's own VFS comparison table on master, cross-checked against
 * this repository's pinned v1.1.2 by running each declared combination.
 */
export const VFS_BUILDS = {
  OPFSAdaptiveVFS: ['async', 'jspi'],
  OPFSWriteAheadVFS: ['sync', 'async', 'jspi'],
  OPFSCoopSyncVFS: ['sync', 'async', 'jspi'],
  AccessHandlePoolVFS: ['sync', 'async', 'jspi'],
  IDBBatchAtomicVFS: ['async', 'jspi'],
} as const satisfies Record<string, readonly [SQLiteBuild, ...SQLiteBuild[]]>;

export type SQLiteVFS = keyof typeof VFS_BUILDS;

/** The build used when the caller does not name one. */
export const defaultBuildFor = (vfs: SQLiteVFS): SQLiteBuild =>
  VFS_BUILDS[vfs][0];

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
