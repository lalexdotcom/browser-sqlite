# `db.debug` — a pool-level request history — design

**Date:** 2026-09-30 · **Status:** approved in chat, spec under review · **Target:** `## [Unreleased]` · **Branch:** `feat/debug-request-history`

`db.debug` stays public and becomes documented, which settles the first of the two `db.debug` entries in `mem:follow-ups`: `API.md` advertises it in the options table while `src/api.ts` tags it `@internal`. The second entry, a worker's `currentRequest` never cleared, disappears with the field. On the way, the tree gains what polling it needs: one history for the whole pool, where a request is visible before it runs, says how long it waited and on what, and survives the death of the worker that served it.

**Success criterion:** a consumer can poll `db.debug`, snapshot it with `structuredClone`, and read from `db.debug.requests` alone which requests are waiting on the cross-tab lock, waiting on the pool, running, done or failed — including those of a worker that has since been replaced.

---

## 1. The shape of the tree

Every field is `readonly`, arrays included. There is no `Proxy` anywhere in the tree.

```ts
type ClientDebugState = {
  readonly file: string;
  readonly vfs: SQLiteVFS;
  readonly pragmas: Readonly<Record<string, string>>;
  readonly name: string;
  readonly queue: { readonly read: number; readonly write: number; readonly gated: number };
  readonly workers: readonly WorkerDebugState[];
  readonly requests: readonly RequestDebugState[];
};

type WorkerDebugState = {
  readonly index: number;
  readonly generation: number;
  readonly name: string;
  readonly creationTime: number;
  readonly initializationTime?: number;
  readonly status: string;
};

type RequestDebugState = {
  readonly kind: 'read' | 'write';
  readonly startTime: number;
  readonly lockTime?: number;
  readonly acquireTime?: number;
  readonly endTime?: number;
  readonly worker?: number;
  readonly generation?: number;
  readonly error?: unknown;
  readonly affected: number;
  readonly rows: number;
  readonly queries: readonly QueryDebugState[];
};

type QueryDebugState = {
  readonly sql: string;
  readonly params?: unknown[];
  readonly startTime: number;
  readonly firstRowTime?: number;
  readonly endTime?: number;
  readonly error?: unknown;
  readonly affected: number;
  readonly rows: number;
  readonly prepared: number;
};
```

### What each new or changed field means

| Field | Meaning |
|---|---|
| `requests` | Every request of the client, chronological by `startTime`. Replaces `workers[].requests`. |
| `WorkerDebugState.generation` | 0 for the slot's first worker, incremented each time the slot's worker is replaced. |
| `WorkerDebugState.status` | A getter reading the pool, as `queue`'s counters already do. Replaces the `Proxy`. |
| `kind` | The lease kind asked for. |
| `startTime` | Taken when the request enters `acquireInstrumented`, before the connection guard and the cross-tab write lock. It used to be taken after both. |
| `lockTime` | The cross-tab write lock was granted. Only on a write, and only on a VFS that shares storage (`sharesStorage`). |
| `acquireTime` | The scheduler lent a worker. |
| `endTime` | The worker was handed back to the pool, or the request failed before getting one. Replaces `releaseTime`, and is named as on a query. |
| `worker`, `generation` | The slot index and the generation of the worker that served the request, set with `acquireTime`. |
| `error` | Why the request ended before the caller received its worker (§ 2.5). The errors of the caller's own statements stay on their query. |
| `affected` | Renamed from `affectedRows`, on the request and on the query. On the request, the sum of its queries. |
| `rows` | On a query, the rows delivered to the pool: the length of every chunk received. On the request, the sum of its queries. |

### Removed

- `WorkerDebugState.requests` and `WorkerDebugState.currentRequest` — replaced by `requests`.
- `RequestDebugState.currentQuery`.
- `RequestDebugState.releaseTime` — renamed `endTime`.
- `affectedRows`, on the request and the query — renamed `affected`.

`currentRequest` and `currentQuery` are not replaced: they are derived from the timestamps, so there is no pointer left to forget to clear.

### Reading a request's state

| `lockTime` | `acquireTime` | `endTime` | `error` | State |
|---|---|---|---|---|
| — | — | — | — | waiting: on the cross-tab lock for a write on a shared VFS, on the pool otherwise |
| set | — | — | — | waiting on the pool |
| any | set | — | — | running |
| any | set | set | — | done |
| any | any | set | set | failed before the caller received its worker |

A worker's current request is the entry of `requests` with its `worker` and `generation`, an `acquireTime` and no `endTime`. A request's current query is its last query without an `endTime`.

### Exported

`ClientDebugState`, `WorkerDebugState`, `RequestDebugState` and `QueryDebugState` are exported from the package entry, so that a consumer can type a polling function. `@internal` is removed from `SQLiteDB.debug`. This reverses the "Not exported" note of `2026-09-24-public-surface-design.md` § 2, which deferred the question to this decision.

## 2. The data flow

### 2.1 One owner

All request tracking happens in `acquireInstrumented` (`src/client.ts`). `acquireWithDebug` is folded into it. When `debug` is off nothing is created and the behaviour is unchanged. The transaction path goes through `acquireInstrumented` already (`createTransaction`'s `scheduler.acquire`), so it is covered without change.

### 2.2 The steps

1. **Entry**, before the connection guard: the entry is created with `kind` and `startTime`, and appended to `requests`.
2. **Write lock granted**: `lockTime`.
3. **Lease lent by the scheduler**: `acquireTime`, `worker`, `generation`; `debug.ts` records the entry as the slot's active request.
4. **Lease released**: `endTime`, and the slot's active request is cleared. This is the moment the worker returns to the pool, not the moment the cross-tab lock is released — that one additionally waits for the epoch publication.
5. **A step throws before the caller receives the lease** — `DATABASE_IN_USE` from the connection guard; a timeout or abort on the write lock; a timeout, abort or `CLIENT_CLOSED` in the scheduler; a failing barrier — `error` is set on the entry. With no worker assigned, `endTime` is set at once. With a worker assigned (a failing barrier), `endTime` waits for the `release` that follows the worker's `quiesce()`, as in step 4.

### 2.3 The slot's active request

`debug.ts` keeps, outside the published tree, the active request of each slot. It is set at step 3 and cleared at step 4, and it is read only to attach a query to its request — never published. A query posted on a slot with no active request is not recorded, as today.

### 2.4 The queries

`src/pool.ts` keeps calling `createQueryDebugState(index, sql, params)`, which attaches the new query to the slot's active request and returns it. The `chunk`, `done` and `error` handlers write into that returned object, held in a variable of the call in flight, instead of reaching through `state.currentRequest.currentQuery`. The additions to the request — `affected` and `rows` — go through `debug.ts`, which knows the query's request.

- `chunk`: `firstRowTime` if unset, and `rows += chunk.length` on the query and its request.
- `done`: `affected`, `prepared`, `endTime` on the query, and `affected` added to the request.
- `error`: `error` and `endTime` on the query.

The barrier's statement is still recorded in its request's queries: a browser test counts barriers there to prove the barrier stays conditional.

### 2.5 The workers

`createWorkerDebugState` increments the slot's generation and replaces `workers[index]`. The previous entry is gone from `workers`; its requests stay in `requests` with its `worker` and `generation`.

### 2.6 The bound

`createClientDebug` receives the configured `poolSize`. On each append, while `requests` is longer than `poolSize × DEBUG_REQUESTS_PER_WORKER`, the oldest entry **with an `endTime`** is removed. An entry without one — waiting or running — is never removed, so the list may exceed the bound while that much work is in flight, and returns to it as the work ends.

The constants are renamed: `MAX_REQUEST_HISTORY_LENGTH` → `DEBUG_REQUESTS_PER_WORKER`, `MAX_QUERY_HISTORY_LENGTH` → `DEBUG_QUERIES_PER_REQUEST`. Both stay at 50.

## 3. Properties the documentation states

The `## *client*.debug` section of `API.md` says:

- what the tree holds, and that it is `undefined` when `debug` is off;
- that it is live — one object, updated in place — so it can be polled by keeping the reference;
- how to snapshot it: `structuredClone` keeps shared references and captures the getters' current values; `JSON.stringify` works too;
- that its shape is **not covered by semver** and may change in any release;
- that it keeps the `params` of the recent queries in memory;
- that one API call can produce several requests — a read `stream()` retried on `BUSY` takes one lease per attempt — and nothing in the tree links them;
- that `rows` counts the rows delivered, so a `first()` or an interrupted `stream()` stops at what was sent;
- how to read a request's state from its timestamps (§ 1).

The options table's `debug` row links to that section.

## 4. Tests

### Unit (`debug.ts` over a fake pool)

- Eviction removes finished entries only, oldest first; the list exceeds `poolSize × DEBUG_REQUESTS_PER_WORKER` while unfinished entries fill it; the order stays chronological.
- `generation` starts at 0 and increments per replacement; entries keep their worker's generation after it is replaced.
- A query attaches to its slot's active request and to no other; after `release`, nothing attaches.
- `rows` and `affected` add up from the query to the request.
- `structuredClone` of the state succeeds and captures the current `status`.

### Browser

- A read queued behind a transaction at `poolSize: 1` is in `requests` without `acquireTime`.
- A write blocked by a second client's write lock on the same file has no `lockTime`, then `lockTime ≤ acquireTime`.
- A wait aborted by `signal` stays in `requests` with `endTime` and `error`.
- The requests of a killed worker stay in `requests`, with its index and its former generation; the slot's new worker has the next generation.
- `rows` equals N on a `SELECT` of N rows, and stops at the delivered count on an interrupted `stream()`.

### Existing tests

Every test that reads the tree is adapted: barrier counts move from `workers[].requests` to `requests`; `open-retry`'s stall report derives the running request from the timestamps instead of `currentRequest`; replacement checks may use `generation` instead of comparing `creationTime`.

## 5. Changelog and delivery

Under `## [Unreleased]`:

- `Changed`, first, prefixed **Breaking:** — `workers[].requests` and `currentRequest` replaced by `db.debug.requests`; `currentQuery` removed; `releaseTime` renamed `endTime`; `affectedRows` renamed `affected`.
- `Added` — `requests`, `kind`, `lockTime`, `error`, `worker` and `generation` on a request, `generation` on a worker, `rows` on a request and a query, the four exported types, the `db.debug` section of `API.md`.
- `Fixed` — a worker no longer reports its last request as current once it has finished.

`src/pool.ts` is touched, so the full verification adds `pnpm test:matrix` to `pnpm test`, `pnpm exec tsc --noEmit` and `biome ci` (`mem:conventions`, "When to run the full matrix"). The two `db.debug` entries of `mem:follow-ups` are deleted at the closure.

## 6. Amendment (2026-10-01): `affected` that is never stale, and internal statements

Decided in chat after the final review, on the same branch.

### 6.1 `affected` is 0 for a statement that changes nothing

The worker reported `sqlite3_changes(db)` after every statement, which SQLite leaves at the previous `INSERT`/`UPDATE`/`DELETE`'s count after a `SELECT`, `BEGIN`, `COMMIT` or DDL. So `write()` returned a stale count, and so did every query of `db.debug`. The worker now reads `sqlite3_total_changes(db)` before and after the statement (exported by all three builds, called directly on the module like `_sqlite3_stmt_status`): if it did not move, `affected` is 0; if it moved, `affected` is `sqlite3_changes(db)`, current by then. **The meaning of `affected` is unchanged** — the rows the statement changed directly, as `changes()` counts them, excluding trigger and foreign-key side effects; only the stale case is fixed. A multi-statement string keeps reporting the count of its last `INSERT`/`UPDATE`/`DELETE`. `write()`'s return changes accordingly (a fix, under `Fixed`), and `bulkWrite()`/`output()` totals with it.

### 6.2 Internal statements are traced, flagged, and left out of the sums

`QueryDebugState` gains `readonly internal: boolean` — `true` for a statement the library sends on its own: the freshness barrier, and a transaction's `BEGIN` (or `BEGIN IMMEDIATE`), `COMMIT` and `ROLLBACK`. They stay in `queries` (the barrier's cost stays visible, and tests count barriers there), but a request's `rows` and `affected` add up only the queries that are not internal. The flag travels as a pool query option `internal?: boolean`, beside `noServed`, and reaches `WorkerDebugHandle.query`. Savepoints the worker runs inside a caller's statement are not separate queries and are unaffected.
