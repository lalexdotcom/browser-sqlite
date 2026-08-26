# A transaction gets the client's whole querying surface

**Date:** 2026-08-26
**Status:** design agreed with the user, ready for an implementation plan.
**Branch:** `feat/tx-query-surface`

## 1. Why

**There is no way to load rows atomically into an existing table.** `bulkWrite()` writes one
statement per batch, each in its own implicit transaction (`bulk.ts`, `flush()`), so a failure
half-way leaves the target half-populated — which is exactly what `BulkWriteError`'s `rowsWritten` /
`rowsNotWritten` exist to report. `output()` is the atomic path, and it only *replaces* a table; it
cannot append. And `TransactionDB` exposes `read`, `write`, `chunk`, `stream`, `first`, `commit`,
`rollback` — **not `bulkWrite`, not `output`** — so a caller who wants all-or-nothing has to
re-implement the batching and the 32766-variable arithmetic by hand inside their own
`transaction()`.

Non-atomic is a defensible contract for a throughput primitive. **Non-atomic with no alternative is
not.** This design does not make `bulkWrite` atomic — a transaction whose lifetime the caller
controls is unbounded, and at `poolSize: 1` (four of nine VFS) a held lease would deadlock the
caller's own reads. It gives the caller the choice instead: `db.bulkWrite` stays streaming and
non-atomic, `tx.bulkWrite` is bounded by the callback and rolls back.

**The two surfaces have already drifted.** `SQLiteDB` takes `params?: any[]`, `TransactionDB` takes
`unknown[]`; `SQLiteDB.chunk` takes `{ chunkSize?, signal? }`, `TransactionDB.chunk` takes the full
options type. Two hand-maintained duplicates of one surface is the mechanism, so the fix is
structural, not a correction.

**And the surface leaks types no consumer can name.** `SQLiteQueryOptions` appears in every query
signature in `dist/*.d.ts` and is not exported. `TransactionDB` appears in `SQLiteDB.transaction`'s
signature (`client.ts:261`) and is not exported. Both are `W-types`' complaint, instantiated.

This also settles the `bulkWrite` half of `ABORT-1` before it is designed: inside a transaction an
abort is a rollback, and outside it "what is written stays written" becomes a documented choice
rather than the only option available.

## 2. The type layer — a new `src/api.ts`

One base type, two surfaces extending it:

```ts
export type SQLiteQueryAPI = {
  read:      <T>(sql, params?: unknown[], options?: SQLiteChunkOptions) => Promise<T[]>;
  write:     <T>(sql, params?: unknown[], options?: SQLiteQueryOptions) => Promise<SQLiteWriteResult<T>>;
  chunk:     <T>(sql, params?: unknown[], options?: SQLiteChunkOptions) => AsyncGenerator<T[]>;
  stream:    <T>(sql, params?: unknown[], options?: SQLiteChunkOptions) => AsyncGenerator<T>;
  first:     <T>(sql, params?: unknown[], options?: SQLiteQueryOptions) => Promise<T | undefined>;
  bulkWrite: <KEYS extends string>(table, keys) => SQLiteBulkWriter<KEYS>;
  output:    <SCHEMA extends Schema>(table, schema, options?: SQLiteOutputOptions<SCHEMA>)
               => SQLiteOutputWriter<SCHEMA>;
};

export type SQLiteDB = SQLiteQueryAPI & {
  transaction: <T>(cb: (db: SQLiteTransactionDB) => Promise<T>,
                   options?: SQLiteTransactionOptions) => Promise<T>;
  close: () => Promise<void>;
  debug?: ClientDebugState;
};

export type SQLiteTransactionDB = SQLiteQueryAPI & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};
```

Named types replacing inline ones:

```ts
SQLiteQueryOptions          { signal? }
SQLiteChunkOptions          SQLiteQueryOptions & { chunkSize? }
SQLiteWriteResult<T>        { result: T[]; affected: number }
SQLiteTransactionOptions    { readOnly?: boolean; autoCommit?: boolean }
SQLiteBulkWriter<KEYS>      { enqueue: (data: Record<KEYS, any>) => void; close: () => Promise<number> }
SQLiteOutputWriter<SCHEMA>  { enqueue: (data: SQLiteOutputRow<SCHEMA>) => void; close: () => Promise<number> }
SQLiteOutputRow<SCHEMA>     the row shape, with `generated` columns excluded — the mapped type
                            currently written inline in `bulk.ts`'s `output()` return
SQLiteOutputOptions<SCHEMA> replaces the current `options?: any`
```

`read` / `chunk` / `stream` take `SQLiteChunkOptions`; `write` / `first` take `SQLiteQueryOptions`.
**The nine `Omit<SQLiteQueryOptions, 'chunkSize'>` disappear** — they compensated for a type that
was too wide.

### 2.1 `stream` gains `chunkSize`; `first` does not

Back-pressure is counted in chunks, window 2, so the worker may run **2 × `chunkSize`** rows ahead
of the consumer's `for await` — about 1000 at the default of 500, which is unchanged. On `stream()`,
where the consumer processes row by row, that is the only lever on the memory bound the README
advertises. On `read()`, which buffers everything anyway, `chunkSize` changes nothing observable —
and today `read()` has it and `stream()` does not. The internal path already forwards it
(`queries.ts:72-83`, `streamRows`); only the public signature strips it.

`first` stays out: it forces `chunkSize: 1` **and** `credits: 1` (`queries.ts:107-126`), which is
the one-row bound its JSDoc promises. A caller-supplied `chunkSize` would break it.

### 2.2 Why a new file rather than `types.ts`

`types.ts` already mixes the wire protocol — internal, which is why `index.ts` re-exports it by an
explicit name list — with the VFS capability table, which is public. Adding the whole public surface
deepens that mixture.

`api.ts` holds public types only. The useful consequence: `index.ts` can `export * from './api'`
with no triage, where `types.ts` needs a name list someone can forget to update. **That is exactly
how `SQLiteQueryOptions` and `TransactionDB` became unnameable.**

`SQLiteDB` moves out of `client.ts` and `SQLiteTransactionDB` out of `transaction.ts`; both files
import them. `Schema` and `OutputOptions` move from `bulk.ts` to `api.ts`; `bulk.ts` imports them
like everyone else. `ClientDebugState` stays in `debug.ts`, imported as a type.

**`CreateSQLiteClientOptions` stays in `client.ts`.** The line is that `api.ts` holds the querying
surface and its satellite types — what a caller passes to a query and gets back. The client's
construction contract belongs beside the constructor that validates it, and nothing but
`client.ts` references it.

### 2.3 Renames

- `TransactionDB` → `SQLiteTransactionDB`, **and exported** — it is not today.
- `BulkWriteError` → `SQLiteBulkWriteError`.
- `params?: any[]` → `unknown[]` on `SQLiteDB`, aligning with what `TransactionDB` already does.
  Not breaking at a call site: a parameter typed `unknown[]` accepts the same arguments.

**Deliberately kept as they are** (user, 2026-08-26): `CreateSQLiteClientOptions`, `VFSCapability`,
`VFSMemoryModel`, and the value `VFS_CAPABILITIES` — the prefix convention is about types, and that
constant is imported by the benchmark page, the README generator and the conformance helpers.

## 3. `createBulk` in two stages

```
createBulk({ file, locks, logger, maxVariables })   →  forTarget
forTarget({ read, write, transaction })             →  { bulkWrite, output }
```

The outer stage keeps everything shared, **including the `swept` memo**. The target stage takes only
the three functions that vary.

`client.ts` calls `forTarget({ read, write, transaction })` once at assembly, and passes
**`forTarget` itself** into `createTransaction`'s deps. Each transaction calls it with its own:

```ts
forTarget({ read: tx.read, write: tx.write, transaction: (fn) => fn(tx) })
```

That `(fn) => fn(tx)` is the whole implicit-BEGIN mechanism: no `BEGIN`, no `COMMIT`, because the
caller's transaction is already open. `output()`'s swap — `DROP`, `RENAME`, then the indexes — runs
on it instead of opening a second one, which SQLite does not allow.

**Consequence, obtained by construction rather than by vigilance:** the sweep stays once per client,
transactions included. Instantiating `createBulk` per transaction would have reset `swept` and swept
on every `tx.output()`.

Unchanged: `bulkWrite`'s internal `before` parameter (by which `output()` passes its staging DDL),
one lease per batch on the non-transactional path, and the UUID-named staging lock.

## 4. The sweep never waits — `tryWithLock`

`sweepOnce()` awaits `locks.withLock(sweepLockName(file), …)`, a Web Lock another client may hold.
Awaiting it **inside an open transaction** means holding SQLite's write lock while waiting on a lock
whose holder may itself be waiting for that write lock. Client A holds the file's write lock and
waits for the sweep lock; client B holds the sweep lock and waits for the write lock to run its
`DROP`s.

**Multi-tab is not required to reach this.** `bsq:sweep:<file>` is contended by anything that opens
the same file, including **two clients in one tab**, each with its own memoized `swept`. That
scenario is explicitly supported — the commit barrier is designed for it and
`tests/browser/barrier.test.ts` exercises it. Nor does deferring `W-multitab` excuse it: `output()`
is the stated exception to that deferral (D3, user requirement), and the sweep exists only for it.

**`Locks` gains `tryWithLock(name, fn)`**, which does not run `fn` when the lock is held elsewhere
instead of waiting (`navigator.locks.request(name, { ifAvailable: true }, …)` yields `null`). The
sweep uses it. A named method rather than an options bag: it states the semantics, and there is one
call site.

This is chosen over skipping the sweep inside a transaction because it removes the cause rather than
routing around it, and leaves **one behaviour instead of two** — no "am I in a transaction?" flag to
thread down into `createBulk`, which is what the injection seam exists to avoid. It also closes a
gap between the code and its own comment: the sweep is already documented as opportunistic
(*"skipping it is correct"*) and today it waits anyway.

**It fixes no existing bug.** Two concurrent `output()` calls do not deadlock today — the second
merely waits, holding no SQLite lock. This removes a hazard the rest of the design would create.

Two things a refactor breaks silently, so they are stated:

**`sweepOnce`'s `!locks.available` guard stays exactly where it is.** It is not made redundant by
`tryWithLock`. Without the Web Locks API, `heldNames()` returns `[]`, so a sweep would judge *every*
staging table an orphan and drop one another tab is filling. Not sweeping is correct; sweeping blind
is not.

**A skipped sweep is still memoized.** If the lock was held, another client was doing the work.
The comment must say so, or it reads as an oversight.

## 5. `readOnly`

An eleventh `SQLiteErrorCode`, `READ_ONLY_TRANSACTION`, and two sites.

**`checksql` stops throwing a bare `Error`** (`transaction.ts:81`) and throws
`SQLiteError('READ_ONLY_TRANSACTION', …)`. It is currently the only guard in the library that
escapes the `code` discriminant.

**`tx.bulkWrite` and `tx.output` throw at the call, not at the first flush.** When `readOnly` is
true, `createTransaction` does not call `forTarget`; it installs two stubs that throw, naming the
offending method. `forTarget` stays ignorant of `readOnly` — it decides *where* writes go, not
*whether* they are allowed.

Without this the caller receives a normal-looking writer, enqueues until the buffer overflows, and
the error surfaces far from its cause — further still for `output()`, whose `CREATE TABLE` failure
is trapped inside the `createStaging` promise. Guarding at the call site is the library's
established shape: the vfs/build guard, the pragma guard and the `AccessHandlePoolVFS` pool guard
all throw at construction.

## 6. Documentation

README, four places:

- **`### Transaction`** — one sentence: `tx` carries the client's whole querying surface —
  `read`, `write`, `chunk`, `stream`, `first`, `bulkWrite`, `output` — plus `commit` and `rollback`.
- **`### output`** — the warning. On its own it loads outside any transaction and holds the write
  lock only for the final swap; on a `tx` the entire load runs under that lock, and every other
  write waits — this tab and others.
- **`### bulkWrite`** — its counterpart. Batches commit as they flush, so a failure leaves the
  already-written rows in place; call it on a `tx` for all-or-nothing.
- **`## Error handling`** — a `READ_ONLY_TRANSACTION` row.

Both warnings also go in JSDoc, where they reach the consumer's editor. Written as a cost to the
caller, not as a mechanism — the project's convention.

**One correction found in passing:** the `### Options` table gives `vfs` as
`Default 'OPFSAdaptiveVFS'`. There is no default since `feat/vfs-required` — that *is* the breaking
change. Fixed in the same pass, or the documentation contradicts the guard.

## 7. Testing

For each pin, the line whose deletion turns it red.

**Node unit tests.** `tests/unit/bulk.test.ts` already drives `createBulk` through its deps, so the
first three need no new machinery.

| pinned | turns red if |
|---|---|
| The sweep runs **once** across two `forTarget` instances from one `createBulk` | `swept` is moved inside `forTarget` |
| `output().close()` on a pass-through `transaction` emits no `BEGIN` / `COMMIT` of its own | the real `transaction()` is wired back in |
| A skipped sweep is memoized — two `output()` calls, one attempt | the `??=` on the refusal path is removed |
| `tryWithLock` does not run `fn` when the lock is held, and does when it is free (`locks.test.ts`, fake `LockManager`) | it is implemented as `withLock` |

**A compile-time pin, with no new tooling.** `tsconfig` already type-checks `tests/`, so a file
assigning `SQLiteDB` and `SQLiteTransactionDB` to `SQLiteQueryAPI` fails `tsc --noEmit` the day
either loses a member. It is the only way to test what section 2 exists to guarantee — types are
erased, and `exports.test.ts` sees values only. Turns red if `bulkWrite` is dropped from
`SQLiteTransactionDB`.

**Browser tests.**

| pinned | turns red if |
|---|---|
| `tx.bulkWrite` then throw → the table is empty | the feature itself regresses |
| `tx.output` then rollback → previous target intact, no staging table left | idem |
| `tx.output` then commit → target replaced | idem |
| A `readOnly` transaction: `tx.bulkWrite(…)` throws `READ_ONLY_TRANSACTION` **at the call** | the stub is made lazy — the throw moves to `close()` |

**The test that needs care — the sweep non-regression.** The test itself takes
`bsq:sweep:<file>` and holds it; a client then opens a transaction, **writes**, and calls
`tx.output()`, which must complete.

- **The preceding write is mandatory.** `BEGIN` is deferred (`transaction.ts:124`), so without it no
  write lock is held and the test passes green while proving nothing.
- It pins the property — *the sweep never waits* — not the deadlock scenario. Reproducing a genuine
  two-party deadlock is not worth its cost; removing the wait is what removes the deadlock. Turns
  red if `tryWithLock` becomes `withLock` again: the test times out.

**Unchanged:** the existing browser tests for `output()`. They are the non-transactional path's
safety net, and they were not written for this work — which is what makes their green credible.

## 8. Out of scope

**Nested `transaction()` on `SQLiteTransactionDB`.** SQLite has no nested `BEGIN`; it would be
`SAVEPOINT` / `RELEASE` / `ROLLBACK TO`, with its own semantics against the already-exposed `commit`
and `rollback` and against `readOnly` / `autoCommit`. A separate design, and purely additive
whenever it is wanted.

**Making `db.bulkWrite` atomic.** Section 1 gives the reasons: caller-controlled lifetime, and a
held lease deadlocking at `poolSize: 1`.

**`ABORT-1`.** `signal` on `bulkWrite` / `output` comes next, on top of this. Doing it first would
mean designing abort semantics for a shape about to gain a sibling.

## 9. What breaks

All of it is unreleased and goes in `CHANGELOG.md`.

- `TransactionDB` → `SQLiteTransactionDB`; `BulkWriteError` → `SQLiteBulkWriteError`.
- `SQLiteQueryOptions` no longer carries `chunkSize`; `SQLiteChunkOptions` does.
- `output`'s options and its `enqueue` are typed rather than `any`, so a call that passed a
  mistyped row stops compiling.
- A write inside a `readOnly` transaction now throws `SQLiteError('READ_ONLY_TRANSACTION')` rather
  than a bare `Error`.
