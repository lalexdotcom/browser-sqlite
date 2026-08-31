import type { CreateSQLiteClientOptions } from './client';
import type { PoolWorker } from './pool';
import type { SQLiteVFS } from './types';

export const debugSQLQuery = (sql: string, params?: unknown[]) => {
  if (!params || params.length === 0) return sql;

  let result = '';
  let paramIndex = 0;
  let i = 0;

  while (i < sql.length) {
    if (sql[i] === '?') {
      // Check if it's a positional parameter (?001, ?002, etc.)
      if (
        i + 3 < sql.length &&
        /\d/.test(sql[i + 1]) &&
        /\d/.test(sql[i + 2]) &&
        /\d/.test(sql[i + 3])
      ) {
        const position = sql.substring(i + 1, i + 4);
        const numIndex = parseInt(position, 10) - 1;

        if (!Number.isNaN(numIndex) && params[numIndex] !== undefined) {
          result += formatValue(params[numIndex]);
        } else {
          result += 'NULL';
        }
        i += 4; // Skip ? and 3 digits
      } else {
        // Simple parameter (?)
        if (paramIndex < params.length) {
          result += formatValue(params[paramIndex++]);
        } else {
          result += 'NULL';
        }
        i++;
      }
    } else if (sql[i] === "'" || sql[i] === '"') {
      // Skip string literals to avoid replacing ? inside them
      const quote = sql[i];
      result += sql[i++];
      while (i < sql.length) {
        result += sql[i];
        if (sql[i] === quote) {
          // Check for escaped quote
          if (i + 1 < sql.length && sql[i + 1] === quote) {
            result += sql[++i];
          } else {
            i++;
            break;
          }
        }
        i++;
      }
    } else {
      result += sql[i++];
    }
  }

  return result;

  function formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    if (typeof value === 'string') {
      return `'${value.replace(/'/g, "''")}'`;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) {
      return `'${value.toISOString()}'`;
    }
    // `Buffer` does not exist in a browser. A Node Buffer is a Uint8Array
    // subclass, so this single branch still covers both.
    if (value instanceof Uint8Array) {
      let hex = '';
      for (const byte of value) {
        hex += byte.toString(16).padStart(2, '0');
      }
      return `X'${hex}'`;
    }
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  }
};

type QueryDebugState = {
  sql: string;
  params?: unknown[] | undefined;
  startTime: number;
  firstRowTime?: number;
  endTime?: number;
  error?: unknown;
  affectedRows: number;
  prepared: number;
};

type RequestDebugState = {
  startTime: number;
  acquireTime?: number;
  releaseTime?: number;
  affectedRows: number;
  queries: QueryDebugState[];
  currentQuery?: QueryDebugState;
};

type WorkerDebugState = {
  index: number;
  name: string;
  creationTime: number;
  initializationTime?: number;
  requests: RequestDebugState[];
  currentRequest?: RequestDebugState;
  readonly status: string;
};

export type ClientDebugState = {
  readonly file: string;
  readonly vfs: SQLiteVFS;
  readonly pragmas: Record<string, string>;
  readonly name: string;
  readonly queue: {
    readonly read: number;
    readonly write: number;
    /**
     * Callers suspended on the pool's readiness gate, waiting for the pool to
     * exist rather than for a free worker. They sit in neither wait queue, so
     * `read` and `write` are both 0 while they wait — during startup, and
     * during the retry round that follows a failed open.
     */
    readonly gated: number;
  };
  workers: WorkerDebugState[];
};

const MAX_QUERY_HISTORY_LENGTH = 50;
const MAX_REQUEST_HISTORY_LENGTH = 50;

export const createClientDebug = (
  file: string,
  pool: (PoolWorker | undefined)[],
  clientOptions: Required<
    Pick<CreateSQLiteClientOptions, 'vfs' | 'pragmas' | 'name'>
  >,
  stats: () => { read: number; write: number; gated: number },
) => {
  const { vfs, pragmas, name } = clientOptions;

  // Read through to the scheduler: the old counters were incremented by hand at
  // every acquire/release site and went stale the moment one was missed.
  const queue = {
    get read() {
      return stats().read;
    },
    get write() {
      return stats().write;
    },
    get gated() {
      return stats().gated;
    },
  };

  const clientState: ClientDebugState = {
    file,
    vfs,
    pragmas,
    name,
    queue,
    workers: [],
  };

  const createWorkerDebugState = (index: number, name: string) => {
    const state: WorkerDebugState = new Proxy(
      {
        index,
        name,
        requests: [],
        status: pool[index]?.status ?? 'EMPTY',
        creationTime: Date.now(),
      },
      {
        get: (target, prop) => {
          if (prop === 'status') {
            return pool[index]?.status ?? 'EMPTY';
          }
          return target[prop as keyof typeof target];
        },
      },
    );
    clientState.workers[index] = state;
    return state;
  };

  const createRequestDebugState = () => {
    const state: RequestDebugState = {
      queries: [],
      startTime: Date.now(),
      affectedRows: 0,
    };
    return {
      state,
      assign: (index: number) => {
        const worker = clientState.workers[index];
        if (worker) {
          state.acquireTime = Date.now();
          // Bounded: this array is pushed to on EVERY request and used to grow
          // with the client's total query count (D5 §1.3, the blocking fix).
          if (worker.requests.length >= MAX_REQUEST_HISTORY_LENGTH)
            worker.requests.shift();
          worker.requests.push(state);
          worker.currentRequest = state;
        }
      },
    };
  };

  const createQueryDebugState = (
    workerIndex: number,
    sql: string,
    params?: unknown[],
  ) => {
    const state: QueryDebugState = {
      sql,
      params,
      startTime: Date.now(),
      affectedRows: 0,
      prepared: 0,
    };
    const worker = clientState.workers[workerIndex];
    if (worker?.currentRequest) {
      if (worker.currentRequest.queries.length >= MAX_QUERY_HISTORY_LENGTH) {
        worker.currentRequest.queries.shift();
      }
      worker.currentRequest.queries.push(state);
      worker.currentRequest.currentQuery = state;
    }
    return state;
  };

  return {
    state: clientState,
    createWorkerDebugState,
    createRequestDebugState,
    createQueryDebugState,
  } as const;
};
