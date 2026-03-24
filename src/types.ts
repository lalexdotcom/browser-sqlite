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
    };

export type WorkerMessageData =
  | { type: 'ready'; callId: number }
  | { type: 'chunk'; callId: number; data: any[] }
  | { type: 'done'; callId: number; affected: number }
  | { type: 'error'; callId: number; message: string; cause?: unknown };

export type SQLiteVFS =
  | 'OPFSPermutedVFS'
  | 'OPFSAdaptiveVFS'
  | 'OPFSCoopSyncVFS'
  | 'AccessHandlePoolVFS'
  | 'IDBBatchAtomicVFS';
