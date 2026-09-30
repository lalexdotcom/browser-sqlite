# `db.debug` pool-level request history — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `db.debug`'s per-worker request history with one pool-level history, make the tree `readonly`, `Proxy`-free and cloneable, and document it as a public, non-semver diagnostic surface.

**Architecture:** `src/debug.ts` owns every mutation of the tree and hands out small handles (`WorkerDebugHandle`, `RequestDebugHandle`, `QueryDebugHandle`); the published types are `readonly`. `src/client.ts`'s `acquireInstrumented` creates a request at entry and drives its handle through lock, lease and release; `src/pool.ts` drives the query handle from its message handlers. The slot's active request lives inside `debug.ts`, outside the published tree.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), rstest (unit project in Node; browser projects in Chromium and Firefox via Playwright), Biome.

**Spec:** `docs/superpowers/specs/2026-09-30-debug-request-history-design.md` — read it before starting; this plan argues from it.

## Global Constraints

- Serena symbolic tools are PRIMARY for code: `get_symbols_overview`, `find_symbol` (`include_body`), `find_referencing_symbols`; edit with `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `replace_content`. Built-in Read/Edit/Grep on code only if Serena fails. Read/Edit are fine for `.md`.
- Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`. Run `pnpm exec tsc --noEmit` yourself before each commit. If the hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- Run `pnpm check` (Biome, writes fixes) after every modification.
- Every commit lands green: `tsc` includes `tests/`, so a type change and every test it breaks go in the same commit.
- Commit messages: Conventional Commits, body says why, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Constants: `DEBUG_REQUESTS_PER_WORKER = 50`, `DEBUG_QUERIES_PER_REQUEST = 50`. Bound on `requests`: `poolSize × DEBUG_REQUESTS_PER_WORKER`, evicting only entries with an `endTime`, oldest first.
- Names are fixed by the spec: `requests`, `generation`, `kind`, `lockTime`, `acquireTime`, `endTime`, `worker`, `error`, `affected`, `rows`. No `currentRequest`, `currentQuery`, `releaseTime`, `affectedRows` anywhere afterwards.
- Comments state the fact in one or two lines; no counts in prose ("the VFS above", never "the five VFS"); a comment the work makes false is corrected in the same commit.
- Consumer docs (`API.md`) state the constraint and what it costs the consumer, not the investigation. No hard-wrapping in Markdown prose.

## Review Focus

- **A late `release()` from a dead worker's lease must not clear the replacement's active request.** Expected: `released()` clears the slot's pointer only if it still points at this request. Pinned in Task 1 (unit).
- **A request whose worker dies mid-query still gets an `endTime`.** Expected: the caller's `finally` releases the lease, so the entry ends and becomes evictable; otherwise it would pin the history forever. Pinned in Task 2 (browser, killed worker).
- **`release()` called twice** (the write path wraps the lease; `Lease.release` is idempotent). Expected: `endTime` set once, never moved. Pinned in Task 1 (unit).
- **The list returns to its bound when a flood of queued requests drains.** Expected: eviction runs when a request ends, not only when one is appended. Pinned in Task 1 (unit).
- **A query posted on a slot with no active request** (outside any lease, or after the release). Expected: not recorded, and never attached to a previous request. Pinned in Task 1 (unit).

---

### Task 1: The pool-level history (debug.ts, pool.ts, client.ts, existing tests)

One atomic change: the new `debug.ts` API breaks `pool.ts`, `client.ts` and every test that reads the tree at compile time, so all of it lands in one commit.

**Files:**
- Modify: `src/debug.ts` (types, constants, `createClientDebug`; `debugSQLQuery` untouched)
- Modify: `src/pool.ts` (deps types ~L267-270; `createWorker` body: L313, L508, the `chunk`/`done`/`error` handlers ~L554-601, the query post ~L685-688)
- Modify: `src/client.ts` (`createClientDebug` call ~L616-627; `acquireWithDebug` ~L865-888 removed; `acquireInstrumented` ~L920-1049 split)
- Test: `tests/unit/debug.test.ts` (the `debug history bounds (D5)` describe is replaced)
- Modify tests that read the old shape: `tests/browser/debug.test.ts`, `tests/browser/helpers.ts`, `tests/browser/barrier.test.ts`, `tests/browser/cross-tab.test.ts`, `tests/browser/statement-cache.test.ts`, `tests/browser/isolated/abort-slot.test.ts`, `tests/browser/writer-spread.test.ts`, `tests/browser/close.test.ts`, `tests/browser/open-retry.test.ts`

**Interfaces:**
- Produces (in `src/debug.ts`, all exported):
  - `type ClientDebugState`, `WorkerDebugState`, `RequestDebugState`, `QueryDebugState` — exactly as in Step 3.
  - `type WorkerDebugHandle = { readonly initialized: () => void }`
  - `type RequestDebugHandle = { readonly locked: () => void; readonly acquired: (index: number) => void; readonly failed: (error: unknown) => void; readonly released: () => void }`
  - `type QueryDebugHandle = { readonly chunk: (rows: number) => void; readonly done: (affected: number, prepared: number) => void; readonly failed: (error: unknown) => void }`
  - `createClientDebug(file, pool, { vfs, pragmas, name, poolSize }, stats)` returning `{ state: ClientDebugState; createWorkerDebugState(index: number, name: string): WorkerDebugHandle; createRequestDebugState(kind: 'read' | 'write'): RequestDebugHandle; createQueryDebugState(index: number, sql: string, params?: unknown[]): QueryDebugHandle | undefined }`
- Consumes: `PoolWorker.status` (`src/pool.ts`), `Lease<W>` (`src/scheduler.ts`: `{ readonly worker: W; release: () => void }`, `release` idempotent).

- [ ] **Step 1: Write the failing unit tests**

In `tests/unit/debug.test.ts`, delete the whole `describe('debug history bounds (D5)', …)` block and put this in its place (the `debugSQLQuery` describe above it is untouched):

```ts
describe('the pool-level request history', () => {
  const options = {
    vfs: 'OPFSCoopSyncVFS',
    pragmas: {},
    name: 'test',
    poolSize: 1,
  } as any;
  const noQueue = () => ({ read: 0, write: 0, gated: 0 });
  const make = (pool: any[] = [], poolSize = 1) =>
    createClientDebug('f.db', pool, { ...options, poolSize }, noQueue);

  it('records a request at creation, before it has a worker', () => {
    const debug = make();
    debug.createRequestDebugState('write');
    const [request] = debug.state.requests;
    expect(request?.kind).toBe('write');
    expect(request?.startTime).toBeGreaterThan(0);
    expect(request?.acquireTime).toBeUndefined();
    expect(request?.worker).toBeUndefined();
  });

  it('stamps lock, acquisition and end, with the worker and its generation', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('write');
    handle.locked();
    handle.acquired(0);
    handle.released();
    const request = debug.state.requests[0]!;
    expect(request.lockTime).toBeGreaterThan(0);
    expect(request.acquireTime).toBeGreaterThanOrEqual(request.lockTime!);
    expect(request.endTime).toBeGreaterThanOrEqual(request.acquireTime!);
    expect(request.worker).toBe(0);
    expect(request.generation).toBe(0);
  });

  it('ends a request that fails before getting a worker at once', () => {
    const debug = make();
    const error = new Error('timed out');
    debug.createRequestDebugState('read').failed(error);
    const request = debug.state.requests[0]!;
    expect(request.error).toBe(error);
    expect(request.endTime).toBeGreaterThan(0);
  });

  it('ends a request that fails after getting a worker only at its release', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('read');
    handle.acquired(0);
    handle.failed(new Error('barrier'));
    expect(debug.state.requests[0]!.endTime).toBeUndefined();
    handle.released();
    expect(debug.state.requests[0]!.endTime).toBeGreaterThan(0);
  });

  it('keeps the first endTime when release is called twice', async () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const handle = debug.createRequestDebugState('read');
    handle.acquired(0);
    handle.released();
    const first = debug.state.requests[0]!.endTime;
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.released();
    expect(debug.state.requests[0]!.endTime).toBe(first);
  });

  it('evicts only finished requests, oldest first', () => {
    const debug = make([], 1);
    debug.createWorkerDebugState(0, 'w0');
    const waiting = debug.createRequestDebugState('read'); // never ends
    for (let i = 0; i < 60; i++) {
      const handle = debug.createRequestDebugState('read');
      handle.acquired(0);
      handle.released();
    }
    const { requests } = debug.state;
    expect(requests.length).toBe(50);
    expect(requests[0]!.endTime).toBeUndefined(); // the waiting one survived
    for (let i = 1; i < requests.length; i++)
      expect(requests[i]!.startTime).toBeGreaterThanOrEqual(
        requests[i - 1]!.startTime,
      );
    waiting.failed(new Error('aborted'));
  });

  it('exceeds the bound while unfinished requests fill it, and returns to it as they end', () => {
    const debug = make([], 1);
    const handles = Array.from({ length: 80 }, () =>
      debug.createRequestDebugState('read'),
    );
    expect(debug.state.requests.length).toBe(80);
    for (const handle of handles) handle.failed(new Error('closed'));
    expect(debug.state.requests.length).toBe(50);
  });

  it('scales the bound with poolSize', () => {
    const debug = make([], 2);
    debug.createWorkerDebugState(0, 'w0');
    for (let i = 0; i < 150; i++) {
      const handle = debug.createRequestDebugState('read');
      handle.acquired(0);
      handle.released();
    }
    expect(debug.state.requests.length).toBe(100);
  });

  it('numbers the generations of a slot, and keeps each request on its own', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const before = debug.createRequestDebugState('read');
    before.acquired(0);
    before.released();
    debug.createWorkerDebugState(0, 'w0'); // the replacement
    const after = debug.createRequestDebugState('read');
    after.acquired(0);
    expect(debug.state.workers[0]!.generation).toBe(1);
    expect(debug.state.requests.map((r) => r.generation)).toEqual([0, 1]);
  });

  it('attaches a query to its slot active request, and to nothing after the release', () => {
    const debug = make([], 2);
    debug.createWorkerDebugState(0, 'w0');
    debug.createWorkerDebugState(1, 'w1');
    const zero = debug.createRequestDebugState('read');
    zero.acquired(0);
    const one = debug.createRequestDebugState('read');
    one.acquired(1);
    debug.createQueryDebugState(1, 'SELECT 1');
    expect(debug.state.requests[0]!.queries).toEqual([]);
    expect(debug.state.requests[1]!.queries.map((q) => q.sql)).toEqual([
      'SELECT 1',
    ]);
    one.released();
    expect(debug.createQueryDebugState(1, 'SELECT 2')).toBeUndefined();
    expect(debug.state.requests[1]!.queries.length).toBe(1);
  });

  it('does not let a dead worker late release clear its replacement active request', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    const dead = debug.createRequestDebugState('read');
    dead.acquired(0);
    debug.createWorkerDebugState(0, 'w0'); // replaced while the lease is out
    const live = debug.createRequestDebugState('read');
    live.acquired(0);
    dead.released(); // the old caller's finally, arriving late
    debug.createQueryDebugState(0, 'SELECT 1');
    expect(debug.state.requests[1]!.queries.map((q) => q.sql)).toEqual([
      'SELECT 1',
    ]);
  });

  it('adds rows and affected up from the query to the request', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('write').acquired(0);
    const first = debug.createQueryDebugState(0, 'SELECT a FROM t')!;
    first.chunk(500);
    first.chunk(20);
    first.done(0, 1);
    const second = debug.createQueryDebugState(0, 'UPDATE t SET a = 1')!;
    second.done(7, 0);
    const request = debug.state.requests[0]!;
    expect(request.queries[0]).toMatchObject({ rows: 520, affected: 0, prepared: 1 });
    expect(request.queries[0]!.firstRowTime).toBeGreaterThan(0);
    expect(request.queries[0]!.endTime).toBeGreaterThan(0);
    expect(request.queries[1]).toMatchObject({ rows: 0, affected: 7, prepared: 0 });
    expect(request).toMatchObject({ rows: 520, affected: 7 });
  });

  it('records a failed query with its error', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    const error = new Error('no such table');
    debug.createQueryDebugState(0, 'SELECT x FROM missing')!.failed(error);
    const query = debug.state.requests[0]!.queries[0]!;
    expect(query.error).toBe(error);
    expect(query.endTime).toBeGreaterThan(0);
  });

  it('bounds the per-request query history at exactly the maximum', () => {
    const debug = make();
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    for (let i = 0; i < 200; i++) debug.createQueryDebugState(0, `SELECT ${i}`);
    expect(debug.state.requests[0]!.queries.length).toBe(50);
  });

  it('exposes queue depths from the scheduler, never a stale copy', () => {
    let depth = { read: 1, write: 2, gated: 3 };
    const debug = createClientDebug('f.db', [], options, () => depth);
    expect(debug.state.queue.read).toBe(1);
    expect(debug.state.queue.gated).toBe(3);
    depth = { read: 7, write: 9, gated: 0 };
    expect(debug.state.queue.read).toBe(7);
    expect(debug.state.queue.write).toBe(9);
    expect(debug.state.queue.gated).toBe(0);
  });

  it('reflects the live pool status, not a construction-time snapshot', () => {
    // A getter re-reads pool[index]?.status on every access; a plain field
    // would stay frozen at 'NEW'.
    const fakeWorker = { status: 'NEW' } as any;
    const debug = make([fakeWorker]);
    debug.createWorkerDebugState(0, 'w0');
    fakeWorker.status = 'READY';
    expect(debug.state.workers[0]!.status).toBe('READY');
  });

  it('survives structuredClone, capturing the current status', () => {
    const fakeWorker = { status: 'RUNNING' } as any;
    const debug = make([fakeWorker]);
    debug.createWorkerDebugState(0, 'w0');
    debug.createRequestDebugState('read').acquired(0);
    debug.createQueryDebugState(0, 'SELECT ?', [1]);
    const snapshot = structuredClone(debug.state);
    expect(snapshot.workers[0]!.status).toBe('RUNNING');
    expect(snapshot.requests[0]!.queries[0]!.params).toEqual([1]);
    fakeWorker.status = 'READY';
    expect(snapshot.workers[0]!.status).toBe('RUNNING');
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm exec rstest --project unit tests/unit/debug.test.ts`
Expected: FAIL — `debug.state.requests` is undefined and `createRequestDebugState` takes no `kind` (TypeScript errors are not reported by rstest; the runtime assertions fail).

- [ ] **Step 3: Rewrite the tree in `src/debug.ts`**

Replace everything in `src/debug.ts` from `type QueryDebugState = {` to the end of the file (the four types, both constants, `createClientDebug`) with the code below. `debugSQLQuery` and the imports at the top stay as they are.

```ts
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

export type WorkerDebugHandle = { readonly initialized: () => void };

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

  const createQueryDebugState = (
    index: number,
    sql: string,
    params?: unknown[],
  ): QueryDebugHandle | undefined => {
    const request = active[index];
    if (!request) return undefined;
    const query: Writable<QueryDebugState> = {
      sql,
      params,
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
        query.firstRowTime ??= Date.now();
        query.rows += rows;
        request.rows += rows;
      },
      done: (affected, prepared) => {
        query.affected = affected;
        query.prepared = prepared;
        query.endTime = Date.now();
        request.affected += affected;
      },
      failed: (error) => {
        query.error = error;
        query.endTime = Date.now();
      },
    };
  };

  return {
    state,
    createWorkerDebugState,
    createRequestDebugState,
    createQueryDebugState,
  } as const;
};
```

If `tsc` rejects the getter in the `Writable<WorkerDebugState>` literal, declare `worker` without the annotation and add `satisfies WorkerDebugState` after the literal; keep the getter.

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec rstest --project unit tests/unit/debug.test.ts`
Expected: PASS, every test of both describes.

- [ ] **Step 5: Wire `src/pool.ts` to the handles**

1. Add to the imports: `import type { QueryDebugHandle, WorkerDebugHandle } from './debug';`
2. In the `createWorker` deps type, replace the two debug members with:

```ts
  createWorkerDebugState?:
    | ((index: number, name: string) => WorkerDebugHandle)
    | undefined;
  createQueryDebugState?:
    | ((
        index: number,
        sql: string,
        params?: unknown[],
      ) => QueryDebugHandle | undefined)
    | undefined;
```

3. `const state = createWorkerDebugState?.(index, workerName);` becomes `const debugWorker = createWorkerDebugState?.(index, workerName);`, and right after `let currentCallId = 0;` add:

```ts
  // The debug record of the query in flight; replaced at every post, like
  // `deferredChunk`, so the callId check below also guards it.
  let debugQuery: QueryDebugHandle | undefined;
```

4. `if (state) state.initializationTime = Date.now();` becomes `debugWorker?.initialized();`
5. In the `chunk` handler, replace the `if (state?.currentRequest?.currentQuery) { … firstRowTime … }` block with `debugQuery?.chunk(data.data.length);`
6. In the `done` handler, replace the `if (state?.currentRequest?.currentQuery) { … }` block (the four assignments) with `debugQuery?.done(affected, data.prepared);`
7. In the `error` handler, replace the `if (state?.currentRequest?.currentQuery) { … }` block with `debugQuery?.failed(error);`
8. At the query post, replace

```ts
      if (state?.currentRequest) {
        const queryState = createQueryDebugState?.(index, sql, params);
        state.currentRequest.currentQuery = queryState;
      }
```

with

```ts
      debugQuery = createQueryDebugState?.(index, sql, params);
```

Check with `find_referencing_symbols` / a grep of `src/pool.ts` that no `state.` / `state?.` reference to the debug state remains.

- [ ] **Step 6: Move request tracking into `acquireInstrumented` in `src/client.ts`**

1. In the `createClientDebug(…)` call, add `poolSize` to the options object: `{ vfs, pragmas, name: clientName, poolSize }` (`poolSize` is the constant declared near the top of `createSQLiteClient`).
2. Delete `acquireWithDebug` and its doc comment.
3. Add `import type { RequestDebugHandle } from './debug';` (merge with the existing `./debug` import).
4. Rename the current `acquireInstrumented` to `acquireLease`, add a third parameter `request: RequestDebugHandle | undefined`, and move its doc comment to the new wrapper below. Inside `acquireLease`:
   - right after `heldWriteLocks.add(webRelease);` add `request?.locked();`
   - replace

```ts
    let lease: Awaited<ReturnType<typeof scheduler.acquire>>;
    try {
      lease = clientDebug
        ? await acquireWithDebug(kind, signal)
        : await scheduler.acquire(kind, signal);
    } catch (error) {
      releaseWrite?.();
      throw error;
    }
```

   with

```ts
    let lease: Awaited<ReturnType<typeof scheduler.acquire>>;
    try {
      lease = await scheduler.acquire(kind, signal);
    } catch (error) {
      releaseWrite?.();
      throw error;
    }
    if (request) {
      request.acquired(lease.worker.index);
      const lent = lease;
      lease = {
        worker: lent.worker,
        release: () => {
          request.released();
          lent.release();
        },
      };
    }
```

5. Directly after `acquireLease`, add the wrapper with the moved doc comment, rewritten:

```ts
  /**
   * The single owner of the request level of the debug tree.
   *
   * Every acquisition goes through here — nothing else calls
   * `scheduler.acquire` — so the request is recorded at the call, before the
   * connection guard and the write lock, and ends at the release or at the
   * first failure. A pass-through when debug is off. The barrier runs on the
   * acquired lease before the caller sees it — the lease atomically covers the
   * barrier statement and the real query together.
   */
  const acquireInstrumented = async (
    kind: 'read' | 'write',
    signal?: AbortSignal,
  ) => {
    const request = clientDebug?.createRequestDebugState(kind);
    try {
      return await acquireLease(kind, signal, request);
    } catch (error) {
      request?.failed(error);
      throw error;
    }
  };
```

Keep every other comment of the old body in `acquireLease`. The barrier's failure path (`void lease.worker.quiesce().then(() => lease.release(), …)`) now calls the wrapped `release`, which is what ends a request that failed after getting its worker — leave it as it is.

- [ ] **Step 7: Adapt the tests that read the old shape**

`tests/browser/barrier.test.ts` — `countBarrierStatements` and the `barriers` constant in the last test: replace

```ts
  (db.debug?.workers ?? [])
    .flatMap((worker) => worker.requests)
    .flatMap((request) => request.queries)
```

with

```ts
  (db.debug?.requests ?? [])
    .flatMap((request) => request.queries)
```

(same change in the `barriers` constant, which starts `const barriers = (db.debug?.workers ?? [])`).

`tests/browser/cross-tab.test.ts` — `countBarrierStatements`: the same replacement.

`tests/browser/statement-cache.test.ts` — `runsOf` and `insertRuns`, and `tests/browser/isolated/abort-slot.test.ts` — `runsOf`: replace `(db.debug?.workers ?? []).flatMap((w) => w.requests).flatMap((r) => r.queries)` with `(db.debug?.requests ?? []).flatMap((r) => r.queries)`.

`tests/browser/writer-spread.test.ts` — `workersServing`:

```ts
const workersServing = (db: TestClient, pattern: RegExp): Set<number> => {
  const indices = new Set<number>();
  for (const request of db.debug?.requests ?? [])
    if (
      request.worker !== undefined &&
      request.queries.some((query) => pattern.test(query.sql))
    )
      indices.add(request.worker);
  return indices;
};
```

`tests/browser/helpers.ts` — `theQueryIsRunning`, body and doc comment kept, predicate becomes:

```ts
export const theQueryIsRunning =
  (db: Awaited<ReturnType<typeof createTestClient>>, sql: string) =>
  (): boolean =>
    (db.debug?.requests ?? []).some((request) => {
      const query = request.queries.at(-1);
      return (
        request.worker !== undefined &&
        request.endTime === undefined &&
        db.debug?.workers[request.worker]?.status === 'RUNNING' &&
        query?.sql === sql &&
        query.endTime === undefined
      );
    });
```

`tests/browser/close.test.ts` — `aRequestIsInFlight`:

```ts
/** A request holds a worker it has not handed back — i.e. a write is live. */
const aRequestIsInFlight =
  (db: Awaited<ReturnType<typeof createTestClient>>) => () =>
    (db.debug?.requests ?? []).some(
      (request) =>
        request.acquireTime !== undefined && request.endTime === undefined,
    );
```

`tests/browser/open-retry.test.ts` — `poolState`: replace the `currentRequest` clause and its comment with a lookup in `requests`:

```ts
  const running = (index: number) =>
    state.requests.some(
      (r) =>
        r.worker === index &&
        r.acquireTime !== undefined &&
        r.endTime === undefined,
    );
  const workers = state.workers.map(
    (w) =>
      `worker ${w.index} ${w.status}` +
      (w.initializationTime === undefined ? ', never initialized' : '') +
      (running(w.index) ? ', a request in flight' : ''),
  );
```

`tests/browser/debug.test.ts` — `populates the whole chain after one read`: replace the body after `expect(state).toBeDefined();` with:

```ts
    const request = state!.requests.find((r) =>
      r.queries.some((q) => q.sql.includes('SELECT')),
    )!;
    expect(request).toBeDefined();
    expect(request.kind).toBe('read');
    expect(request.worker).toBeDefined();
    expect(request.acquireTime).toBeGreaterThanOrEqual(request.startTime);
    expect(request.endTime).toBeGreaterThanOrEqual(request.acquireTime!);

    const query = request.queries.at(-1)!;
    expect(query.sql).toContain('SELECT');
    expect(query.endTime).toBeGreaterThan(0);
    expect(query.firstRowTime).toBeGreaterThan(0);
    expect(query.rows).toBe(1);
    expect(request.rows).toBe(1);

    await db.close();
```

The `tx-abort`, `tx-handle` and `tx-savepoint` tests read only `creationTime`, which stays: leave them.

- [ ] **Step 8: Verify**

Run: `pnpm check && pnpm exec tsc --noEmit`
Expected: no error; `grep -rn "currentRequest\|currentQuery\|releaseTime\|affectedRows\|acquireWithDebug" src tests` prints nothing.

Run: `pnpm test:unit`
Expected: PASS.

Run: `pnpm exec rstest --project 'chromium*' tests/browser/debug.test.ts tests/browser/barrier.test.ts tests/browser/cross-tab.test.ts tests/browser/statement-cache.test.ts tests/browser/writer-spread.test.ts tests/browser/close.test.ts tests/browser/open-retry.test.ts tests/browser/interrupt.test.ts tests/browser/long-query.test.ts`
Expected: PASS.

Run: `pnpm test:isolated`
Expected: PASS (covers `abort-slot.test.ts`).

- [ ] **Step 9: Commit**

```bash
git add src/debug.ts src/pool.ts src/client.ts tests/unit/debug.test.ts tests/browser
git commit -m "feat(debug)!: one request history for the whole pool

A request was recorded per worker and only once it had one, so a request
waiting on the pool or the cross-tab lock was invisible, a failed wait
left no trace, and a dead worker took its history with it. The tree is
now readonly, cloneable (no Proxy), and derives what currentRequest and
currentQuery claimed, which were never cleared.

BREAKING CHANGE: db.debug.workers[].requests and currentRequest are
replaced by db.debug.requests; currentQuery is removed; releaseTime is
renamed endTime and affectedRows affected.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Browser tests for what only the real pool shows

These pin Task 1's integration; they are expected to pass on arrival. Each one's falsifiability is checked by the sabotage named in its comment — apply it, see the test fail, revert — before committing.

**Files:**
- Test: `tests/browser/debug.test.ts` (new `describe` appended)

**Interfaces:**
- Consumes: `db.debug.requests` / `workers` as defined in Task 1; `createTestClient`, `interceptWorkers`, `longQuery`, `sleep`, `waitUntil`, `pairFor`, `type Skip` from `tests/browser/helpers.ts`; `poolFor` from `tests/conformance/helpers.ts`; `createSQLiteClient`, `deleteDatabase`.

- [ ] **Step 1: Write the tests**

Append to `tests/browser/debug.test.ts`, extending its imports as needed (`waitUntil`, `interceptWorkers`, `longQuery`, `sleep`, `pairFor`, `type Skip` from `./helpers`; `poolFor` from `../conformance/helpers`; `deleteDatabase` from `../../src/delete`):

```ts
describe('the pool-level request history', () => {
  /** Holds the only worker in a transaction until `release()`. */
  const holdTheWorker = (db: Awaited<ReturnType<typeof createTestClient>>) => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const done = db.transaction(async () => {
      entered.resolve();
      await gate.promise;
    });
    return { entered: entered.promise, release: () => gate.resolve(), done };
  };

  // Falsifiable: create the request after `scheduler.acquire` in
  // acquireInstrumented — the queued read is then absent.
  it('shows a read queued behind a transaction before it has a worker', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const hold = holdTheWorker(db);
    await hold.entered;

    const queued = db.read('SELECT a FROM t');
    await waitUntil(
      () => db.debug!.requests.some((r) => r.kind === 'read' && r.acquireTime === undefined),
      'the queued read in requests',
    );

    hold.release();
    await Promise.all([hold.done, queued]);
    const read = db.debug!.requests.findLast((r) => r.kind === 'read')!;
    expect(read.acquireTime).toBeGreaterThan(read.startTime);
    expect(read.endTime).toBeDefined();
  });

  // Falsifiable: drop `request?.failed(error)` from acquireInstrumented — the
  // aborted wait keeps no endTime and no error.
  it('keeps a wait aborted by its signal, with its error', async () => {
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');
    const hold = holdTheWorker(db);
    await hold.entered;

    const controller = new AbortController();
    const aborted = db.read('SELECT a FROM t', [], { signal: controller.signal });
    await waitUntil(
      () => db.debug!.requests.some((r) => r.kind === 'read'),
      'the waiting read in requests',
    );
    controller.abort(new Error('gave up'));
    await expect(aborted).rejects.toBeDefined();

    const read = db.debug!.requests.find((r) => r.kind === 'read')!;
    expect(read.acquireTime).toBeUndefined();
    expect(read.endTime).toBeDefined();
    expect(read.error).toBeDefined();
    hold.release();
    await hold.done;
  });

  // Falsifiable: have createWorkerDebugState also drop the slot's entries from
  // `requests` — the crashed read disappears.
  it('keeps the requests of a killed worker, with its generation', async () => {
    const records = interceptWorkers();
    const db = await createTestClient({ poolSize: 1, debug: true });
    await db.write('CREATE TABLE t (a)');

    const running = db.read(longQuery(20_000_000));
    await sleep(100);
    records[0]!.worker.dispatchEvent(new ErrorEvent('error'));
    await expect(running).rejects.toMatchObject({ code: 'WORKER_CRASHED' });
    await db.read('SELECT 1 AS n');

    const { requests, workers } = db.debug!;
    expect(workers[0]!.generation).toBe(1);
    const crashed = requests.find((r) =>
      r.queries.some((q) => q.sql.includes('WITH RECURSIVE')),
    )!;
    expect(crashed).toMatchObject({ worker: 0, generation: 0 });
    expect(crashed.endTime).toBeDefined();
    expect(requests.at(-1)).toMatchObject({ worker: 0, generation: 1 });
  });

  // Falsifiable: stop adding `rows` in the query handle's `chunk`.
  it('counts the rows delivered, and stops at what a first() received', async () => {
    const db = await createTestClient({ debug: true });
    await db.write('CREATE TABLE t (a)');
    await db.write(
      'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000) INSERT INTO t SELECT x FROM c',
    );

    await db.read('SELECT a FROM t');
    await db.first('SELECT a FROM t');

    const reads = db.debug!.requests.filter((r) =>
      r.queries.some((q) => q.sql === 'SELECT a FROM t'),
    );
    const [all, first] = reads.map(
      (r) => r.queries.find((q) => q.sql === 'SELECT a FROM t')!,
    );
    expect(all!.rows).toBe(1000);
    expect(first!.rows).toBeGreaterThanOrEqual(1);
    expect(first!.rows).toBeLessThan(1000);
  });
});

describe('the cross-tab write lock in the history', () => {
  const NEEDS = ['shared-second-client'] as const;

  const twoClients = (skip: Skip) => {
    const { vfs, build } = pairFor(NEEDS, skip);
    const dbName = `bsq-test-${crypto.randomUUID()}`;
    const options = { vfs, build, poolSize: poolFor(vfs) };
    const a = createSQLiteClient(dbName, options);
    const b = createSQLiteClient(dbName, { ...options, debug: true });
    onTestFinished(async () => {
      for (const client of [a, b]) await client.close().catch(() => {});
      await deleteDatabase(dbName, { vfs, build }).catch(() => {});
    });
    return { a, b };
  };

  // Falsifiable: drop `request?.locked()` from acquireLease — lockTime never appears.
  it('shows a write waiting on another client lock, then when it got it', async ({ skip }) => {
    const { a, b } = twoClients(skip);
    await a.write('CREATE TABLE t (a)');
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const holding = a.transaction(async () => {
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;

    const blocked = b.write('INSERT INTO t VALUES (1)');
    await waitUntil(
      () => b.debug!.requests.some((r) => r.kind === 'write'),
      'the blocked write in requests',
    );
    await sleep(50);
    const waiting = b.debug!.requests.find((r) => r.kind === 'write')!;
    expect(waiting.lockTime).toBeUndefined();

    gate.resolve();
    await Promise.all([holding, blocked]);
    const write = b.debug!.requests.find((r) => r.kind === 'write')!;
    expect(write.lockTime).toBeDefined();
    expect(write.acquireTime).toBeGreaterThanOrEqual(write.lockTime!);
  });
});
```

If `createTestClient`'s return type does not expose `transaction` with a callback taking no argument, pass `async (_tx) => { … }`. If `first()` rewrites its SQL before posting it, match the rewritten text in the rows test instead of `'SELECT a FROM t'` — check `first` in `src/client.ts` before running.

- [ ] **Step 2: Run them on both engines**

Run: `pnpm exec rstest --project 'chromium*' tests/browser/debug.test.ts` then `pnpm exec rstest --config rstest.firefox.config.ts tests/browser/debug.test.ts`
Expected: PASS on both (the cross-tab test may report skipped on a pair without `shared-second-client`; `pnpm test`'s pairs have it).

- [ ] **Step 3: Check each test's falsifiability**

For each test, apply the sabotage named in its comment, re-run the Chromium command, see that test fail, revert with `git checkout -- src`. Record in the task report which tests failed under which sabotage.

- [ ] **Step 4: Commit**

```bash
pnpm check && pnpm exec tsc --noEmit
git add tests/browser/debug.test.ts
git commit -m "test(debug): pin the pool-level history on a real pool

Queued and aborted waits, a killed worker's requests, delivered rows and
the cross-tab lock wait are only visible with real workers and locks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The public surface and its documentation

**Files:**
- Modify: `src/index.ts` (type export)
- Modify: `src/api.ts` (`SQLiteDB.debug` doc comment)
- Modify: `API.md` (options row for `debug`; new `## *client*.debug` section between `## *client*.inspect` and `## *client*.close`)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)

**Interfaces:**
- Consumes: the four types from Task 1.
- Produces: `ClientDebugState`, `WorkerDebugState`, `RequestDebugState`, `QueryDebugState` importable from the package entry.

- [ ] **Step 1: Write the failing type-level test**

Append to `tests/unit/exports.test.ts`:

```ts
import type {
  ClientDebugState,
  QueryDebugState,
  RequestDebugState,
  WorkerDebugState,
} from '../../src/index';

/**
 * The debug tree's types are importable from the entry, so a consumer can type
 * a polling function. Falsifiable: drop the export from src/index.ts.
 */
type _DebugTypesExported = [
  ClientDebugState,
  WorkerDebugState,
  RequestDebugState,
  QueryDebugState,
];
```

(Move the `import type` up with the file's other imports.)

- [ ] **Step 2: Run tsc to verify it fails**

Run: `pnpm exec tsc --noEmit`
Expected: FAIL — `Module '"../../src/index"' has no exported member 'ClientDebugState'` (and the three others).

- [ ] **Step 3: Export the types and rewrite the doc comment**

In `src/index.ts`, after `export * from './delete';`:

```ts
export type {
  ClientDebugState,
  QueryDebugState,
  RequestDebugState,
  WorkerDebugState,
} from './debug';
```

In `src/api.ts`, replace the doc comment of `debug?: ClientDebugState | undefined;` with:

```ts
  /**
   * The live introspection tree, `undefined` unless the `debug` option is set.
   * One object updated in place: keep the reference and poll it. Its shape is
   * outside semver and may change in any release.
   */
```

- [ ] **Step 4: Run tsc to verify it passes**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test:unit`
Expected: PASS.

- [ ] **Step 5: Document `db.debug` in `API.md`**

In the options table, the `debug` row becomes:

```
| `debug` | `string \| boolean` | `undefined` | Lifecycle logging, and the [`db.debug`](#clientdebug) introspection tree. |
```

Insert this section before `## *client*.close`:

```markdown
## *client*.debug

`ClientDebugState | undefined`, readonly. The pool as it is right now, when the [`debug`](#options) option is set; `undefined` otherwise. **Its shape is outside semver: any release may change it.**

It is one object, updated in place: keep the reference and read it as often as you like. To keep a moment of it, `structuredClone(db.debug)` — or `JSON.stringify`, which loses nothing either.

| Field | What it holds |
|---|---|
| `file`, `vfs`, `pragmas`, `name` | What the client opened, and the name its log lines carry. |
| `queue` | Callers waiting for a worker (`read`, `write`), and for the pool to exist (`gated`). |
| `workers` | One entry per slot: `index`, `generation` (0 for the slot's first worker, +1 per replacement), `name`, `creationTime`, `initializationTime`, `status`. |
| `requests` | The client's recent requests, oldest first. |

**A request is one lease of a worker**: a `read()` is one, and so is a whole transaction. It carries `kind` (`'read'` or `'write'`), `startTime` (the call), `lockTime` (the cross-tab write lock was granted — a write on a VFS whose storage other tabs share), `acquireTime` (a worker was lent), `endTime` (the worker went back, or the request failed before getting one), `worker` and `generation` (who served it), `error` (why it ended before running), `affected`, `rows` and `queries`. Its state is in its timestamps:

| `lockTime` | `acquireTime` | `endTime` | `error` | The request is |
|---|---|---|---|---|
| — | — | — | — | waiting: on another tab's write lock for a write on a shared VFS, on the pool otherwise |
| set | — | — | — | waiting on the pool |
| | set | — | — | running |
| | set | set | — | done |
| | | set | set | failed before your code received its worker |

**A query is one SQL text sent during a request**: `sql`, `params`, `startTime`, `firstRowTime`, `endTime`, `error`, `affected`, `rows` and `prepared` (statements SQLite had to compile; 0 when the statement cache served it). `rows` counts the rows sent to your code, so a `first()` or a `stream()` you left early stops at what it received. A request may begin with a statement of this library's own, which makes a worker see what another one committed, before yours.

The history keeps 50 requests per worker of the pool, and 50 queries per request; a request still waiting or running is never dropped. **It keeps `params` in memory** — the values you bound, for every query it holds. One call can make several requests: a `stream()` that meets `BUSY` takes a new lease for each attempt, and nothing links them.
```

- [ ] **Step 6: Add the CHANGELOG entries**

Under `## [Unreleased]`, invoke the `changelog-maintenance` skill (AGENTS.md) and add, following the file's existing style:

- `### Changed`, as the FIRST entry: `- **Breaking:** **\`db.debug\` keeps one request history for the whole pool.** \`db.debug.requests\` replaces each worker's \`requests\` and \`currentRequest\`; \`currentQuery\` is gone — a request's state is in its timestamps; \`releaseTime\` is now \`endTime\` and \`affectedRows\` is \`affected\`, on requests and queries. \`db.debug\` is documented, and its shape is outside semver.`
- `### Added`: `- **\`db.debug\` shows a request from the call on**: waiting on another tab's write lock (\`lockTime\`), on the pool (\`acquireTime\`), running, done, or failed before it ran (\`error\`), with the \`worker\` and \`generation\` that served it — so the requests of a replaced worker stay readable. Queries and requests count the \`rows\` they delivered. The tree can be copied with \`structuredClone\`, and its types — \`ClientDebugState\`, \`WorkerDebugState\`, \`RequestDebugState\`, \`QueryDebugState\` — are exported.`
- `### Fixed`: `- A worker no longer reports its last request as current once that request has finished.`

- [ ] **Step 7: Verify and commit**

Run: `pnpm check && pnpm exec tsc --noEmit && pnpm test:unit`
Expected: PASS.

```bash
git add src/index.ts src/api.ts tests/unit/exports.test.ts API.md CHANGELOG.md
git commit -m "docs(debug): document db.debug and export its types

db.debug was advertised in the options table and tagged @internal at the
same time; it is public, and says that its shape is outside semver.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Delivery (not a task — the closure)

After the whole-branch review: `pnpm test`, `pnpm exec tsc --noEmit`, `biome ci`, and `pnpm test:matrix` (`src/pool.ts` is touched — `mem:conventions`, "When to run the full matrix"), all reports read. Then the two `db.debug` entries of `mem:follow-ups` are deleted, `mem:state` updated, and the branch merged with `--no-ff` on the user's go.
