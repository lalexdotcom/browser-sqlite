import type { CreateSQLiteClientOptions } from './client';
import type { SQLiteVFS } from './const/vfs';
import type { PoolWorker } from './pool';
import type { BootStage, RunStage } from './types/protocol';

// Public as the types of `WorkerDebugState.boot` and `.run`; the rest of the
// protocol stays internal.
export type { BootStage, RunStage };

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
  /** True for a statement the library sends on its own — the freshness barrier, a transaction's BEGIN, COMMIT and ROLLBACK, and the savepoint operations. */
  readonly internal: boolean;
  /** Milliseconds spent in each run stage, cumulated; only the stages the worker announced. */
  readonly stages: Readonly<Partial<Record<RunStage, number>>>;
};

export type RequestDebugState = {
  readonly kind: 'read' | 'write' | 'verdict';
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
  /**
   * The step the worker's open has reached, set as each one begins; it stays
   * at the last one once the worker is ready. Where an open never finishes,
   * it names the step that did not.
   */
  readonly boot?: BootStage;
  /** What the worker is doing for its query now; absent when idle. */
  readonly run?: RunStage;
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
  readonly boot: (stage: BootStage) => void;
  /** Sets the worker's run stage, or clears it on `undefined`. */
  readonly run: (stage: RunStage | undefined) => void;
  /** Attaches to the slot's active request only if it is still this worker's own generation. */
  readonly query: (
    sql: string,
    params?: unknown[],
    internal?: boolean,
  ) => QueryDebugHandle | undefined;
  /**
   * The internal query of a verdict: attached to the newest live lent request
   * of the slot, else to its active one (same generation rule as `query`).
   */
  readonly verdict: (sql: string) => QueryDebugHandle | undefined;
};

export type RequestDebugHandle = {
  readonly locked: () => void;
  /**
   * `borrowed`: the lease is lent by a transaction for a verdict. The slot's
   * active request is left alone (the transaction goes on posting in it); the
   * lent request is only reachable through the worker handle's `verdict`.
   */
  readonly acquired: (index: number, borrowed?: boolean) => void;
  /** Ends the request at once unless it holds a worker; then `released` does. */
  readonly failed: (error: unknown) => void;
  readonly released: () => void;
};

export type QueryDebugHandle = {
  readonly chunk: (rows: number) => void;
  /** Begins `stage`, closing the current one with `elapsed` — or the page's time since it began. */
  readonly stage: (stage: RunStage, elapsed: number | undefined) => void;
  readonly done: (
    affected: number,
    prepared: number,
    elapsed?: number | undefined,
  ) => void;
  readonly failed: (error: unknown, elapsed?: number | undefined) => void;
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
  // Per slot, the requests of the borrowed leases (a transaction lending its
  // idle worker to a verdict), oldest first. A lend never becomes `active`:
  // the transaction goes on posting its statements during the lend.
  const lending: Writable<RequestDebugState>[][] = [];

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
    // Bound to this worker's own generation: a stale handle from a dead worker
    // must not attach to the replacement's request.
    const attach = (
      request: Writable<RequestDebugState> | undefined,
      sql: string,
      params: unknown[] | undefined,
      internal: boolean,
    ): QueryDebugHandle | undefined => {
      if (!request || request.generation !== generation) return undefined;
      // The current stage and the page instant it began, for the cumulation.
      const stages: Partial<Record<RunStage, number>> = {};
      let current: RunStage | undefined;
      let began = 0;
      const close = (elapsed: number | undefined) => {
        if (current === undefined) return;
        stages[current] =
          (stages[current] ?? 0) + (elapsed ?? performance.now() - began);
        current = undefined;
      };
      const query: Writable<QueryDebugState> = {
        sql,
        params,
        internal,
        startTime: Date.now(),
        affected: 0,
        rows: 0,
        prepared: 0,
        stages,
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
        stage: (stage, elapsed) => {
          if (query.endTime !== undefined) return;
          close(elapsed);
          current = stage;
          began = performance.now();
        },
        done: (affected, prepared, elapsed) => {
          if (query.endTime !== undefined) return;
          close(elapsed);
          query.affected = affected;
          query.prepared = prepared;
          query.endTime = Date.now();
          if (!internal) request.affected += affected;
        },
        failed: (error, elapsed) => {
          if (query.endTime !== undefined) return;
          close(elapsed);
          query.error = error;
          query.endTime = Date.now();
        },
      };
    };
    return {
      initialized: () => {
        worker.initializationTime = Date.now();
      },
      boot: (stage) => {
        worker.boot = stage;
      },
      run: (stage) => {
        if (stage === undefined) delete worker.run;
        else worker.run = stage;
      },
      query: (sql, params, internal = false) =>
        attach(active[index], sql, params, internal),
      verdict: (sql) => {
        // The newest live lend (a transaction lending its idle worker to a
        // verdict), else the slot's active request.
        const lent = lending[index];
        let request = active[index];
        for (let i = (lent?.length ?? 0) - 1; i >= 0; i--) {
          const candidate = lent?.[i];
          if (
            candidate?.endTime === undefined &&
            candidate?.generation === generation
          ) {
            request = candidate;
            break;
          }
        }
        return attach(request, sql, undefined, true);
      },
    };
  };

  const createRequestDebugState = (
    kind: RequestDebugState['kind'],
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
      acquired: (index, borrowed = false) => {
        request.acquireTime = Date.now();
        request.worker = index;
        request.generation = generations[index] ?? 0;
        if (borrowed) {
          const lent = lending[index] ?? [];
          lent.push(request);
          lending[index] = lent;
        } else active[index] = request;
      },
      failed: (error) => {
        request.error = error;
        if (request.acquireTime === undefined) end();
      },
      released: () => {
        if (request.worker !== undefined) {
          // A dead worker's lease can come back after its slot was re-lent.
          if (active[request.worker] === request)
            active[request.worker] = undefined;
          const lent = lending[request.worker];
          const at = lent?.indexOf(request) ?? -1;
          if (at >= 0) lent?.splice(at, 1);
        }
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
