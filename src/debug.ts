import type { CreateSQLiteClientOptions } from './client';
import type { SQLiteVFS } from './const/vfs';
import type { PoolWorker } from './pool';

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

export type QueryDebugState = {
  readonly sql: string;
  readonly params?: unknown[] | undefined;
  readonly startTime: number;
  readonly firstRowTime?: number;
  readonly endTime?: number;
  readonly error?: unknown;
  readonly affected: number;
  /** Rows delivered to the pool: a `first()` or an abandoned `stream()` stops short. */
  readonly rows: number;
  /** Statements SQLite compiled for this call — 0 when the statement cache served it. */
  readonly prepared: number;
  /** True for a statement the library sends on its own — the freshness barrier, a transaction's BEGIN, COMMIT and ROLLBACK. */
  readonly internal: boolean;
};

export type RequestDebugState = {
  readonly kind: 'read' | 'write';
  /** At the call, before the connection guard and the cross-tab write lock. */
  readonly startTime: number;
  /** The cross-tab write lock was granted — a write on a VFS that shares storage. */
  readonly lockTime?: number;
  readonly acquireTime?: number;
  /** The worker went back to the pool, or the request failed before getting one. */
  readonly endTime?: number;
  readonly worker?: number;
  readonly generation?: number;
  /** Why the request ended before the caller received its worker. */
  readonly error?: unknown;
  readonly affected: number;
  readonly rows: number;
  readonly queries: readonly QueryDebugState[];
};

export type WorkerDebugState = {
  readonly index: number;
  /** 0 for the slot's first worker, +1 per replacement. */
  readonly generation: number;
  readonly name: string;
  readonly creationTime: number;
  readonly initializationTime?: number;
  readonly status: string;
};

export type ClientDebugState = {
  readonly file: string;
  readonly vfs: SQLiteVFS;
  readonly pragmas: Readonly<Record<string, string>>;
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
  readonly workers: readonly WorkerDebugState[];
  /** Every request of the client, by `startTime`; only finished ones are evicted. */
  readonly requests: readonly RequestDebugState[];
};

export type WorkerDebugHandle = {
  readonly initialized: () => void;
  /** Attaches to the slot's active request only if it is still this worker's own generation. */
  readonly query: (
    sql: string,
    params?: unknown[],
    internal?: boolean,
  ) => QueryDebugHandle | undefined;
};

export type RequestDebugHandle = {
  readonly locked: () => void;
  readonly acquired: (index: number) => void;
  /** Ends the request at once unless it holds a worker; then `released` does. */
  readonly failed: (error: unknown) => void;
  readonly released: () => void;
};

export type QueryDebugHandle = {
  readonly chunk: (rows: number) => void;
  readonly done: (affected: number, prepared: number) => void;
  readonly failed: (error: unknown) => void;
};

/** A published type as this module alone holds it: writable, arrays included. */
type Writable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[] ? E[] : T[K];
};

const DEBUG_QUERIES_PER_REQUEST = 50;
const DEBUG_REQUESTS_PER_WORKER = 50;

export const createClientDebug = (
  file: string,
  pool: readonly (PoolWorker | undefined)[],
  clientOptions: Required<
    Pick<CreateSQLiteClientOptions, 'vfs' | 'pragmas' | 'name'>
  > & { poolSize: number },
  stats: () => { read: number; write: number; gated: number },
) => {
  const { vfs, pragmas, name, poolSize } = clientOptions;

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

  const workers: WorkerDebugState[] = [];
  const requests: Writable<RequestDebugState>[] = [];
  const state: ClientDebugState = {
    file,
    vfs,
    pragmas,
    name,
    queue,
    workers,
    requests,
  };

  // Per slot, outside the published tree: the generation of its worker and the
  // request its lease serves, which is how a query finds its request.
  const generations: number[] = [];
  const active: (Writable<RequestDebugState> | undefined)[] = [];

  // Runs on append and on end, so the list returns to the bound as a queue drains.
  const evict = () => {
    let excess = requests.length - poolSize * DEBUG_REQUESTS_PER_WORKER;
    for (let i = 0; excess > 0 && i < requests.length; ) {
      if (requests[i]?.endTime === undefined) {
        i++;
      } else {
        requests.splice(i, 1);
        excess--;
      }
    }
  };

  const createWorkerDebugState = (
    index: number,
    workerName: string,
  ): WorkerDebugHandle => {
    const previous = generations[index];
    const generation = previous === undefined ? 0 : previous + 1;
    generations[index] = generation;
    const worker: Writable<WorkerDebugState> = {
      index,
      generation,
      name: workerName,
      creationTime: Date.now(),
      get status() {
        return pool[index]?.status ?? 'EMPTY';
      },
    };
    workers[index] = worker;
    return {
      initialized: () => {
        worker.initializationTime = Date.now();
      },
      query: (sql, params, internal = false) => {
        // Bound to this worker's own generation: a stale handle from a dead
        // worker must not attach to the replacement's request.
        const request = active[index];
        if (!request || request.generation !== generation) return undefined;
        const query: Writable<QueryDebugState> = {
          sql,
          params,
          internal,
          startTime: Date.now(),
          affected: 0,
          rows: 0,
          prepared: 0,
        };
        if (request.queries.length >= DEBUG_QUERIES_PER_REQUEST)
          request.queries.shift();
        request.queries.push(query);
        return {
          chunk: (rows) => {
            // A worker's death can post its failure after the message that
            // already ended this query; a finished query is not rewritten.
            if (query.endTime !== undefined) return;
            query.firstRowTime ??= Date.now();
            query.rows += rows;
            if (!internal) request.rows += rows;
          },
          done: (affected, prepared) => {
            if (query.endTime !== undefined) return;
            query.affected = affected;
            query.prepared = prepared;
            query.endTime = Date.now();
            if (!internal) request.affected += affected;
          },
          failed: (error) => {
            if (query.endTime !== undefined) return;
            query.error = error;
            query.endTime = Date.now();
          },
        };
      },
    };
  };

  const createRequestDebugState = (
    kind: 'read' | 'write',
  ): RequestDebugHandle => {
    const request: Writable<RequestDebugState> = {
      kind,
      startTime: Date.now(),
      affected: 0,
      rows: 0,
      queries: [],
    };
    requests.push(request);
    evict();
    const end = () => {
      if (request.endTime !== undefined) return;
      request.endTime = Date.now();
      evict();
    };
    return {
      locked: () => {
        request.lockTime = Date.now();
      },
      acquired: (index) => {
        request.acquireTime = Date.now();
        request.worker = index;
        request.generation = generations[index] ?? 0;
        active[index] = request;
      },
      failed: (error) => {
        request.error = error;
        if (request.acquireTime === undefined) end();
      },
      released: () => {
        // A dead worker's lease can come back after its slot was re-lent.
        if (request.worker !== undefined && active[request.worker] === request)
          active[request.worker] = undefined;
        end();
      },
    };
  };

  return {
    state,
    createWorkerDebugState,
    createRequestDebugState,
  } as const;
};
