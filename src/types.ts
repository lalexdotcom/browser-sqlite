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
  | { type: 'error'; callId: number; message: string; cause?: unknown }
  | { type: 'closed'; callId: number }
  | {
      type: 'open-error';
      callId: number;
      message: string;
      cause?: unknown;
    };

export type SQLiteVFS =
  | 'OPFSPermutedVFS'
  | 'OPFSAdaptiveVFS'
  | 'OPFSCoopSyncVFS'
  | 'AccessHandlePoolVFS'
  | 'IDBBatchAtomicVFS';

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
