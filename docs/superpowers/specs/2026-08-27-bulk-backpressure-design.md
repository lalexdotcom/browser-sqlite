# `bulkWrite` back-pressure — design

**Status:** approved 2026-08-27, not implemented.
**Backlog item:** `BACKPRESSURE-1` in `mem:follow-ups`.

The library has back-pressure in one direction only. BP-1's credit window
(`src/credits.ts`) bounds worker → client chunk delivery for `chunk()` and
`stream()`. Nothing bounds the client → worker direction, which is where the one
API meant for large volumes lives.

## 1. What has no answer today

`enqueue()` is synchronous and returns nothing. It pushes into a buffer and, at
`maxBufferSize`, calls `flush()`, which splices the buffer and **chains** the
write onto `writePromise`. Nothing is ever awaited, so a caller can enqueue a
million rows in a tight loop without yielding.

The *buffer* is bounded: never more than `floor(32766 / keys.length)` rows. The
*chain of pending batches is not*. Each `.then()` link captures its own
`toInsert` array of up to that many rows, and nothing caps the number of links.
A producer faster than SQLite — a JavaScript loop against OPFS writes, i.e. the
normal case — grows memory with batches in flight.

`mem:vfs` records that this project exists to stop loading large structures into
memory. This is the one place the library does it on the user's behalf.

## 2. Non-goals

- **Atomicity.** `bulkWrite` remains non-atomic; batches commit as they flush.
- **A hard memory guarantee.** See decision 1: the bound is cooperative. A
  caller who ignores the returned promise gets today's behaviour, and the
  documentation must say so in those words rather than implying a guarantee.
- **A timed flush.** Proposed and deliberately excluded — see §7.
- **A `drain()` method.** `close()` already drains everything, and `drain()`
  would serve only a producer refusing to await `enqueue()`. Nobody has asked.

## 3. Decisions

Taken with the user on 2026-08-27, in this order.

1. **Cooperative, not enforced.** `enqueue()` returns a promise. Awaiting it
   slows the producer; ignoring it is legal and behaves exactly as today,
   memory growth included. `void` → `Promise<void>` breaks nothing, at compile
   time or at runtime.

   Rejected: throwing at the cap (breaks every loop written against the current
   documentation, and turns a slow load into a failed one — the wrong remedy for
   a caller who only wanted to be slowed).

2. **The cap is counted in rows**, the unit the caller enqueues in.

   Rejected: counting batches. It is the exact unit of the leak, and a batch is
   always ≤ 32 766 bound values whatever the table — but it asks the consumer to
   know a chunking rule that is an implementation detail.

3. **The default is derived from the column count; an explicit value is taken
   as given.** No clamping, no warning. Under decision 1 a too-high cap is not a
   hazard: it yields *less* back-pressure, which is today's behaviour, and
   clamping would need a memory threshold the library cannot measure.

4. **The promise never rejects.** It signals one thing: there is room. Failures
   and aborts keep their existing exits — `enqueue()` throws on the next call,
   `close()` rejects. Any other choice contradicts decision 1: a rejected
   promise nobody awaits is an `unhandledrejection`, one per failed load.

   This also preserves B5. The internal chain must never reject, or a rejection
   skips the later `.then()` links and drops already-spliced rows in silence.

## 4. Public surface

```typescript
export type SQLiteBulkWriter<KEYS extends string> = {
  /**
   * Buffers a row, flushing automatically when the buffer fills.
   *
   * Awaiting the returned promise applies back-pressure: it is already
   * resolved while fewer than `maxPendingRows` rows are in flight, and
   * resolves once a batch settles when they are not. Ignoring it is legal
   * and leaves the load unbounded, as it was before this option existed.
   *
   * It never rejects. A failed batch surfaces at the next `enqueue()`, which
   * throws, and at `close()`, which rejects.
   */
  enqueue: (data: Record<KEYS, any>) => Promise<void>;
  close: () => Promise<number>;
};
```

`maxPendingRows?: number` joins `SQLiteBulkWriteOptions` and
`SQLiteOutputOptions`. `output()`'s writer changes the same way — it wraps the
same `enqueue`, and a load that stages its rows has the same problem.

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPendingRows` | `number` | `2 × floor(32766 / columns)` | Rows in flight above which `enqueue()`'s promise defers instead of being already resolved. |

The default is 13 106 rows at 5 columns and 2 184 at 30 — about two batches
either way, so the memory bounded is roughly the same from one table to the
next. That was the whole merit of counting in batches, obtained without
imposing the word.

The column count is known at the call (`bulkWrite(table, keys)`, and the
schema for `output()`), so the default needs no deferred state.

## 5. Mechanism

- **`pendingRows`**, a counter. `flush()` adds `toInsert.length`; the chain link
  subtracts it when it settles, on every path — success, latched failure, and
  the batch an abort skipped.
- **`enqueue()`** compares after pushing. Below the cap it returns a **shared,
  already-resolved promise** held as a module constant: no allocation per row.
  At or above it, it returns a single deferred, the same one for every call
  while the writer is over the cap, resolved as soon as `pendingRows` falls
  back below.
- **One deferred, no waiter queue.** `enqueue()` is not concurrent-safe today
  and this does not make it so; a single producer is the only shape that has to
  work.
- **An explicit cap smaller than one batch is legal** and means one INSERT in
  flight, the minimum the chunking allows. It is documented, not rounded.

### The abort must release the waiter

If the signal fires while a producer awaits `enqueue()`, the deferred resolves
immediately. Without that, a producer parked on a pool that never frees a worker
cannot be abandoned — the exact hole ABORT-1 paid for three times, in three
different `await`s (`mem:lessons`). The producer leaves its `await`, and its next
`enqueue()` throws `signal.reason` through the guard that already exists.

## 6. Verification

Unit tests, in `tests/unit/bulk.test.ts` — none of this needs a browser.

1. `enqueue()` resolves without deferring while under the cap.
2. It defers once `pendingRows` reaches the cap, and resolves when a batch
   settles.
3. The default cap derives from the column count: a 30-column writer defers
   earlier, in rows, than a 5-column one.
4. An explicit cap is honoured, including one smaller than a single batch.
5. **A failed batch resolves the promise rather than rejecting it**, and the
   failure still surfaces at the next `enqueue()` and at `close()`.
6. An abort releases a waiting `enqueue()`, whose next call throws
   `signal.reason`.
7. `output()` honours the option.

Each test names the line whose deletion makes it fail, per `mem:lessons`.

## 7. Left open deliberately

**A timed flush**, proposed by the user on 2026-08-27 and excluded here. Its
memory argument is weak: the buffer is already bounded at one batch, the
smallest unit in the system, while the unbounded part is the chain this spec
bounds. What a timer really buys is latency and durability — a slow producer's
rows reaching SQLite without waiting for `close()` — and it costs exactly on the
workload it targets: `bulkWrite` already commits per batch, and a timer on a
trickle multiplies commits, hence OPFS fsyncs, instead of grouping them. Each
flush also takes a write lease, which on a VFS rotating one exclusive handle
serializes the pool to write three rows. And the timer must be cancelled at
`close()`, at an abort and at a failure — lifecycle state in a class that is
purely reactive today.

**`maxBufferBytes`**, the honest form of the memory concern behind the timer.
The buffer is bounded in *values*, not bytes: a single TEXT column admits 32 766
rows, which with 10 KB blobs is 327 MB held before the first flush. A size
trigger empties exactly when it must, where a timer empties on elapsed time
whether the buffer holds 3 KB or 300 MB. Not in this spec; recorded so the case
is not rediscovered as a surprise.
