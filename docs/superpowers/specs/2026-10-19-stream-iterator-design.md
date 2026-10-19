# `stream()` through a hand-written iterator over chunks

Date: 2026-10-19. Branch: `perf/stream-iterator`. Background: `mem:follow-ups/stream-iterator`, STREAM-GEN in `mem:measurements/footprint`.

## The two rules (user, 2026-10-19) — they override everything below

1. **No change of behaviour.** Anything a consumer of `stream()` or `tx.stream()` can observe stays as it is today — rows, order, errors and when they arrive, abort, `break`/`return()`/`throw()`, retry, abandon, the lease and the transaction's queue, the declared type. Speed is the only difference. Where today's behaviour is unclear, it is measured on `main` and reproduced, never re-decided.
2. **Maximum reliability.** Every behaviour of the adapter is pinned by a test that fails on a wrong implementation (falsified once by a deliberate mutation, recorded in the report); the comparison with today's shape is exhaustive over the scripted scenarios and randomised beyond them; the existing browser tests run unchanged on every pair, repeatedly. A doubt is resolved by keeping today's code path, not by an argument.

## Why

Since the fast step (FAST-STEP), the worker no longer pays wa-sqlite's `async` `step()` per row, and `chunk()` of 4 000 000 rows on `MemoryVFS` takes 839 ms on Firefox `sync`. `stream()` over the same rows still takes about 5 s. The difference is page side: `stream()` hands out rows through nested async generators, and every `next()` on an async generator, and every `yield*` between them, costs promise turns per row.

- `client.stream()` (`src/client.ts`): `streamRows` (`src/queries.ts`, flattens chunks into rows) → `streamWithRetry` (`yield*`) → `stream` (`yield*`) → the consumer's `for await`.
- `tx.stream()` (`src/transaction.ts`): `streamRows` → `releasing` (the transaction's statement queue and lifecycle) → the consumer.

Pure-JS probe, 4 000 000 rows in chunks of 1 000, ms, Chrome 153 / Firefox 155.0.1 (STREAM-GEN): three nested generators 802 / 4 489, one generator 365 / 2 190, a hand-written iterator over a chunk generator 122 / 185, chunks read by a plain `for` 15 / 21.

## Goals

- `client.stream()` and `tx.stream()` hand out rows through a hand-written async iterator over a generator of chunks, so that a row taken from a chunk already received costs one resolved promise and nothing more.
- No behaviour visible to a consumer changes, except speed: the same rows in the same order, the same errors at the same points, the same abort, `break`, `return()` and `throw()` behaviour, the same retry, the same abandon handling, the same public type.

## Non-goals

- `chunk()`, `tx.chunk()`, `read()`, `first()` and every other method: unchanged.
- No change to the worker, the transport or the decoding.
- No new public API.

## Anti-goals — a failure even if `stream()` got faster

- A query left running, a lease never returned, or a transaction statement left in its queue after the consumer stopped reading (`break`, `return()`, a throw in the loop body, an abandoned iterator collected by the GC).
- A query re-run after a row was delivered (rows repeated), or a `BUSY` before the first row no longer retried.
- A `tx.stream()` that joins the transaction's queue before its first `next()`: a stream created and never read would block every later statement of the transaction.
- Two chunk fetches in flight on one stream, or a `return()` that closes the source under a pending `next()`.
- A change of `stream()`'s declared type for TypeScript consumers.

## The design (user, 2026-10-16 and 2026-10-19)

**The lifecycle stays in the generators; only the flattening is hand-written.** Every generator that owns a resource today keeps it, but yields chunks instead of rows:

- `client.stream()` becomes the flattening of the same chunk generator `client.chunk()` uses (deadline, `streamWithRetry`, `chunkWorker`), with `stream` as the method name in its messages (`assertReadable`, `withDeadline`). The retry "before a single row has been delivered" becomes "before the first chunk", the same moment, since a chunk is delivered with its first row.
- `tx.stream()` becomes the flattening of `releasing(<the chunk source tx.chunk() uses>, entry, st, 'stream')`, so the queue, `open`, the release and the abandon paths stay in `releasing` as they are.
- `streamRows` is no longer used and is removed.

**The adapter**, one function (name and file left to the builder, e.g. `flatten` in `src/queries.ts`), takes an `AsyncGenerator<T[]>` and returns an `AsyncGenerator<T>`:

- `next()`: if the current chunk has a row left, `Promise.resolve({ value, done: false })`; otherwise it asks the source for the next chunk and serves its first row; an empty chunk is skipped; the source's end is `done`.
- **Lazy**: the source is not touched before the first `next()`.
- **Serialised**: a `next()` called while a chunk fetch is pending waits for that fetch instead of starting another; results are delivered in call order.
- `return(value)`: waits for a pending fetch, then calls the source's `return()` once (its `finally` blocks do the cleanup), then is `done`; a second `return()` does not call the source again.
- `throw(error)`: forwarded to the source's `throw()` (a generator suspended at a `yield` runs its `finally`), then `done`; the error is rethrown to the caller as an async generator's `throw()` would.
- An error from the source rejects that `next()` and ends the iterator; later `next()` calls are `done` without calling the source.
- `next()` after `done` is `done`, without calling the source.
- `[Symbol.asyncIterator]()` returns itself. Whatever `AsyncGenerator` declares under the library's TypeScript `lib` (`ES2024`) is implemented, so `stream()`'s declared return type stays `AsyncGenerator<T, void, unknown>`.

**Settled after the builder check (designer's calls, each keeping today's behaviour):**

- **`return()` or `throw()` before the first `next()` calls nothing on the source**, as an unstarted async generator does today: `return()` resolves `done`, `throw(e)` rejects with `e`, and the iterator is `done`.
- **The transaction closes the adapter, not `releasing`.** `closeOpenStatements` calls `entry.gen.return()` when the callback ends; for `tx.stream()`, `entry.gen` is the adapter (set where `releasing` sets it today), so the close also drops the rows buffered in the adapter, and a later `next()` is `done` as it is today. The adapter's `return()` then reaches `releasing`'s `return()`, which runs its `finally` as today.
- **The per-row abort of a savepointed `tx.stream()` is kept.** Today `releasing`'s savepointed branch races the statement's own signal (`st.own`) on every row, so an abort rejects the very next row even when it was already received. The adapter takes an optional signal: before serving a buffered row, if it is aborted, the adapter calls the source's `throw(signal.reason)` and rejects with what that rejects with. `releasing`'s savepointed branch, suspended at its `yield`, then runs its existing `catch` (the abandon of the write through `drainToEnd`) and `finally` — no logic moves into the adapter. Only the savepointed `tx.stream()` passes the signal; `client.stream()` and a non-savepointed `tx.stream()` check per chunk today (`drain`, the plain `for await`) and keep doing so.
- **No empty chunk can precede the first row**: the worker posts a chunk only once it holds a row (`run()` in `src/worker/worker.ts` yields a block after `writer.row`, and the final block only if a writer exists), and `drain` forwards only those. So `streamWithRetry`'s `delivered`, set when the chunk generator yields, flips with the first row, as today.

**Abandon by the GC is unchanged.** The abandon registry watches the chunk generator created in `src/queries.ts`'s `chunk()` factory; the adapter is its only owner once `stream()` returns, so a consumer dropping the iterator lets both be collected, as the generator chain is collected today.

## Tests

1. **The adapter alone, in the unit project**, against a scripted source (a generator whose chunks, delays, errors and `return()`/`throw()` calls are recorded). One literal `it` per behaviour above: laziness; rows of several chunks in order, empty chunks skipped; two `next()` without awaiting → one fetch; `return()` during a pending `next()`; `return()` twice → one source `return()`; `break` mid-chunk in a `for await` → exactly one source `return()`; `throw()`; a source error after N rows, then `done`; `next()` after `done`.
2. **A differential test, in the unit project**: the same scripted consumer actions (read k rows then `break`; `return()` mid-chunk; `throw()` mid-chunk; a source error at chunk j; a consumer that throws in its loop body) run against today's shape — a row-flattening async generator under a `yield*` — and against the adapter over the same source; the traces must be identical: rows received, calls made on the source (`next`, `return`, `throw`) in order, errors. Today's behaviour is the reference.
   **Randomised as well (rule 2):** a seeded generator of consumer scripts (sequences of `next()` awaited or not, `return()`, `throw()`, `break`, a throw in the loop body, at random points) over seeded sources (chunk sizes including 1, delays, an error at a random chunk, early end), thousands of cases per run against both shapes, traces compared; a failing case prints its seed so it can be replayed as a literal test. Plus the savepointed per-row abort: a signal aborted mid-chunk rejects the next row and reaches the source's `throw()` exactly as today's `raceAbort` path does.
3. **The browser tests that already pin `stream()` run unchanged**: `abandon`, `early-exit`, `stream-retention`, `query-timeout`, `interrupt`, `queries`, `results`, `routing`, `writer-spread`, `params`, `sql-tag`, the transaction tests that use `tx.stream()`, and `abandon-gc` with `BSQ_EXPOSE_GC=1` on Chrome. A test that has to change means the semantics changed: stop and report.
   Those files also run on every eligible pair (`node scripts/test-plan.ts --mode all-pairs <files>`), on both engines, several times in a row, so a race introduced by the change shows rather than hides behind one green run. A new browser test pins what the unit tests cannot see: `tx.stream()` left open when the callback ends (the transaction closes it, later rows are not served), and a savepointed `tx.stream()` aborted mid-chunk.
4. The usual delivery gate (`node scripts/hook-gate.ts delivery --run`), and the matrix on GitHub before the merge: the branch touches `src/transaction.ts` (`mem:conventions`, § What runs where).

## Measurements

Before and after, as FAST-STEP: the direct harness rebuilt under `.scratchpad/`, stock Chrome 153 and Firefox 155.0.1 from `node_modules/.cache/wdio/` (the Firefox install carries the `DisableAppUpdate` policy; check `navigator.userAgent` in every run's log), `main`'s build and the branch's served side by side and alternated within each repetition, n ≥ 3, row counts checked on every run:

- `client.stream()` over 4 000 000 rows of two integers, `MemoryVFS`, `sync`, `async` and `jspi`, default `chunkSize` and 5 000;
- `tx.stream()` over the same rows, `sync`, inside `transaction()`;
- `chunk()` on `sync`, to show it unchanged.

Results go to `mem:measurements` with an ID, the conclusion to `mem:follow-ups/stream-iterator` (closed by the merge: the entry moves to history).

## Deliverables beyond the code

- `CHANGELOG.md`, `[Unreleased]` › Changed: `stream()` is faster, most on Firefox. No figures.
- Memories: the measurement entry, `mem:follow-ups` and `mem:state` updated at the merge.

## Left to the builder

The adapter's name, file and internal shape; how the internal chunk generator of `client.chunk()` is shared with `client.stream()` (a helper taking the method name); the scripted source of the unit tests; the harness changes.
