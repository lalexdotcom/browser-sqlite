# `db.ready` — a promise for the pool's startup — design

**Date:** 2026-09-23 · **Status:** approved in chat, spec under review · **Target:** rc.6 (`## Unreleased`) · **Branch:** `feat/db-ready`

Nothing public says when a client's pool has finished starting. `db.poolSize` is exact only from that moment, and today its contract has to lean on "every query waits for that". This design adds `db.ready: Promise<void>`, which settles at that moment, and gives the bench its first consumer.

Shape agreed with the user on 2026-09-13 while designing the environment pool cap (`2026-09-13-pool-environment-cap-design.md`, D7) and moved to rc.6 by the triage rule. Refined in chat on 2026-09-23; every section below was approved there.

---

## 1. The public contract

```ts
/**
 * Settles once the pool has started: every worker has opened, declined, or
 * failed its one retry. Resolves when at least one worker serves the database;
 * rejects with the error that failed the client otherwise, and with
 * `CLIENT_CLOSED` when `close()` comes first. Never needs awaiting — queries
 * wait on their own — and never raises an unhandled rejection when unread.
 */
readonly ready: Promise<void>;
```

- **A property, not an `onReady` option** (user, 2026-09-13).
- **Resolves** when the scheduler's startup gate opens — after the retry round when there is one — and only if the client was not failed at that point. `db.poolSize` is final from then on.
- **Rejects** with:
  - the error `failClient` receives on a total startup failure (typically `WORKER_CRASHED`: every worker failed, or worker 0 died before answering the probe);
  - `DATABASE_IN_USE` when the client is refused on a database held exclusively;
  - `CLIENT_CLOSED` when `close()` is called before the gate opens.
- **One-shot.** Once settled it never moves. A worker lost later is reported by `onWorkerLost`; a client failed later is reported by its queries.
- **Pending exactly as long as a query would wait at the gate** — no more, no less. `openTimeout` already bounds that wait.
- **No unhandled rejection when unread**: an internal `.catch(() => {})` is attached, as for `gateDeferred`. A consumer who awaits it still sees the rejection.
- **`db.poolSize`'s JSDoc** becomes "exact once `db.ready` resolves", replacing "every query waits for that, so it is settled by the time any query returns".

## 2. Why it is not derived from the scheduler's gate

The follow-up entry said `ready` "derives from the scheduler's `gateDeferred.promise`". The code does not allow it. `settleGateSlot` (`src/scheduler.ts`) resolves `gateDeferred` **and then** calls `onGateOpen`, and `onGateOpen` (`src/client.ts`) may then call `failClient` — when the pool is empty at gate-open, or when worker 0 was lost before answering the probe. Queries survive this because `acquire()` re-checks `shutdownReason` after the gate. A `ready` derived from the gate would **resolve on a client that fails in the same tick**.

So `ready` is its own deferred in the client, settled where the verdict is known. Put to the user and approved, 2026-09-23.

## 3. Implementation

Two files in `src/`.

- **`src/client.ts`** — `const readyDeferred = Promise.withResolvers<void>()`, with `void readyDeferred.promise.catch(() => {})`. Settled in three places, first one wins:

  | where | call |
  |---|---|
  | end of `onGateOpen` | `readyDeferred.resolve()` |
  | `failClient` | `readyDeferred.reject(fatal)` |
  | `close()`, before `scheduler.shutdown` | `readyDeferred.reject(closingError)` |

  When `onGateOpen` itself calls `failClient`, the rejection lands first and the resolve at the end is a no-op. The returned client exposes `ready: readyDeferred.promise`.
- **`src/api.ts`** — `ready` on `SQLiteClient` with the JSDoc of §1; `poolSize`'s JSDoc rewritten.

## 4. Tests

Browser tests, each with a stated falsifier. Placed where their fixtures already live rather than in a new file, so no fixture is moved or duplicated.

| # | case | file | falsifier |
|---|---|---|---|
| 1 | resolves on a healthy client | `tests/browser/ready.test.ts` (new) | never resolve |
| 2 | on a capped engine, `db.poolSize` equals the effective size once `ready` resolves, with no query issued | `tests/browser/pool-cap.test.ts` | resolve at creation (Firefox then reads 4, not 1) |
| 3 | total startup failure (worker URL missing): rejects `WORKER_CRASHED` | `tests/browser/lifecycle.test.ts`, startup describe | drop the reject in `failClient` |
| 4 | pool empty at gate-open (`failWorkersFromIndex` scenario): rejects | `tests/browser/lifecycle.test.ts`, startup describe | resolve at the START of `onGateOpen`, or from `gateDeferred` — **this test guards §2** |
| 5 | `close()` before the gate opens: rejects `CLIENT_CLOSED` | `tests/browser/ready.test.ts` | drop the reject in `close()` |
| 6 | exclusive refusal: `b.ready` rejects `DATABASE_IN_USE` | `tests/browser/second-client.test.ts`, the refused branch | as 3, on the other path |
| 7 | a failed client whose `ready` nobody reads raises no `unhandledrejection` | `tests/browser/lifecycle.test.ts` | drop the internal `.catch` |

Cases 4 and 6 run only where their scenario exists (`two-workers`; the refused outcome of the second-client matrix). Cases 1 and 5 carry no `needs` and run on all 22 pairs, so **the full matrix is owed at delivery** (`mem:conventions`, "When to run the full matrix"). It also covers the wa-sqlite repin of 2026-09-23, which is owed the matrix independently.

## 5. Documentation and CHANGELOG

- **`API.md`**: a new `## *client*.ready` section right after `*client*.poolSize`, carrying §1's contract for the consumer — when it resolves, what it rejects with, that queries never need it. `*client*.poolSize` becomes "exact once [`ready`](#clientready) resolves". The `createSQLiteClient` intro gains a half-sentence pointing to `ready` for knowing when startup is over. The navigation line at the top of `API.md` and the one in `README.md` gain `*client*.ready`.
- **`CHANGELOG.md`**: an `### Added` entry under `## Unreleased`.

Consumer documentation is edited iteratively and not committed per pass (`mem:conventions`).

## 6. The bench

`scripts/bench/html/index.html`, agreed with the user on 2026-09-23:

- **The column header** reads `pool N` when the column is created (before its client exists), then `pool N → M` once `ready` resolves and the effective size `M` differs from the requested `N`. Equal sizes keep `pool N`. A rejected `ready` leaves `pool N`; the column fails as it does today.
- **The VFS selector's label** keeps the requested size — no client exists when VFS are chosen.
- **The burst row** bounds its ranking by the effective size: `capBy` is the only place the pool size enters it (`ctx.pool` is set and never read). Today `capBy` returns `poolFor`, which is 4 for `OPFSAdaptiveVFS` on Firefox and Safari, where it runs 1 — so a gain above 1 there is ranked as if it were possible.

Verified with `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all`; on Safari, served from the container and run by the user.

## 7. Out of scope

- Re-settling `ready` after startup. A later loss or failure has its own channels.
- An `onReady` option (refused, §1).
- Other bench clients created with `poolSize: poolFor(...)` inside individual rows: they are not column headers and their size is not displayed.
