export type SQLiteClientCallData =
  | {
      type: 'open';
      file: string;
      workerIndex: number;
      url?: string;
      flag: SharedArrayBuffer;
    }
  | {
      type: 'sql';
      sql: string;
      params?: any[];
      options?: { debug?: boolean; chunkSize?: number };
    }
  | { type: 'abort' };

export type SQLiteCLientCallParams<K extends SQLiteClientCallData['type']> =
  Omit<Extract<SQLiteClientCallData, { type: K }>, 'type'>;

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

type SQLOptions = { chunkSize?: number };

export type ClientMessageData =
  | {
      type: 'open';
      file: string;
      flags: SharedArrayBuffer;
      index: number;
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
  // PROBE SCAFFOLDING (wave 4, BP-1) — remove or promote once the measurement
  // is recorded. Answers: is a postMessage delivered to a worker while it is
  // inside a query? See mem:follow-ups BP-1.
  | { type: 'ping'; callId: number; postedAt: number };

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  | { type: 'chunk'; callId: number; data: any[] }
  | { type: 'done'; callId: number; affected: number }
  | { type: 'error'; callId: number; message: string; cause?: unknown }
  | { type: 'closed'; callId: number }
  // PROBE SCAFFOLDING (wave 4, BP-1) — see ClientMessageData['ping'].
  | {
      type: 'pong';
      callId: number;
      postedAt: number;
      handledAt: number;
      inQuery: boolean;
    }
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
