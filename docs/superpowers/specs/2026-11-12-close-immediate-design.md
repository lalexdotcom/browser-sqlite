# `close({ immediate: true })` — design

Date: 2026-11-12. Follow-up: `mem:follow-ups/close-immediate`. Branch: `feat/close-immediate`.

## Intent

`close()` today drains: a plain query already running (`run`, `all`, `first`, `stream`, `chunk`, a `bulkWrite`/`output` batch) is waited for, bounded by `drainTimeout` (60 s by default), before each worker is closed and terminated. Queued work and pending write-lock requests already reject at once with `CLIENT_CLOSED`, and a transaction is already abandoned through `closeSignal`.

The user wants a **violent close the caller can choose**: an option under which `close()` does not wait for the statements in flight. It is **opt-in**; `close()` without the option keeps its current behaviour exactly.

## Decided with the user

- **Shape:** `close(options?: { immediate?: boolean })`. `await db.close({ immediate: true })`. `close()` and `close({})` and `close({ immediate: false })` are today's drain.
- **Two steps under the option:**
  1. **Interrupt first.** Every statement in flight is interrupted. Where the interruption reaches SQLite — the `async` and `jspi` builds everywhere, the `sync` build when the page is cross-origin isolated — the statement stops and the worker then closes its connection cleanly.
  2. **Wait for nothing else.** A worker that cannot give its statement up — the `sync` build without cross-origin isolation — is terminated at once, without waiting for `drainTimeout`.
- **Rejection:** every call interrupted by the option rejects with `CLIENT_CLOSED` (code and message as the queued calls get today), not with the abort's reason.
- **Accepted costs** (documented, not fixed):
  - A write that completed just before the interruption may reject although it landed — the same misreport `API.md` cites as the reason the default drains.
  - A write cut by a termination is lost and rolled back by SQLite's journal at the next open, as for a closed tab.
  - On Safari, the WASM of a terminated worker keeps running to the end of its statement (WebKit 328618). On the `sync` build without isolation, a write rejected by `close({ immediate: true })` may therefore still land **after** `close()` resolved, and the file stays held meanwhile: a client opened at once on the same database may fail.

## Calls in flight, per kind (decided)

- `run` / `all` / `first`: reject with `CLIENT_CLOSED`.
- `stream()` / `chunk()` being consumed: the pending or next `next()` rejects with `CLIENT_CLOSED`.
- `bulkWrite()` / `output()`: their `close()` rejects with `BULK_WRITE_FAILED` (a `SQLiteBulkWriteError` whose `cause` has code `CLIENT_CLOSED`, carrying `rowsWritten`/`rowsNotWritten`) — what the default `close()` already does, kept so the default stays unchanged (ruling 2026-11-13, Task 1); the batches already written stay, as for an abort (`output()`'s target untouched, staging dropped where the worker is still alive to drop it). An `enqueue()` after the client closed throws as it does today.
- `transaction()`: unchanged — it is already abandoned by `closeSignal` and rejects with `CLIENT_CLOSED`, and the default `close()` already interrupts the statement it has in flight (`closeSignal` feeds the transaction's signal; `closeOpenStatements` calls `worker.interrupt` then `quiesce()`). The only change under the option is on the non-interruptible path: the worker is terminated instead of waited on. No second client-wide signal goes into `transaction.ts`.

## Builder's latitude, with the calls already made (agent's calls, not the user's)

- **Which path a worker takes is known at construction.** `BUILD_CAPABILITIES[build].interruptibleWithout` (`src/const/builds.ts`) together with `available.has('cross-origin-isolated')` — equivalently `build !== 'sync' || abortSlots !== undefined` — says whether a running statement can be stopped. Under the option:
  - *interruptible*: interrupt, then `worker.close()` and `terminate(closingError)` as today. Expected cost: milliseconds.
  - *not interruptible*: a worker computing inside a statement is terminated at once with `closingError`; an idle worker is closed cleanly first, as today. A `sync` worker parked on a credit (a paused `stream()`/`chunk()`) reads messages, so it may take the interruptible path (`stop`, then a clean close) if the pool can tell that state apart; if it cannot, terminating it is acceptable.
- **No wait of `drainTimeout` under the option, on any path.** The user agreed to "immediate everywhere, clean wherever possible". An interrupted worker that has not given its statement up within a short grace (of the order of `QUIESCE_GRACE_MS`; the value is the builder's) is terminated with `closingError`, as on the non-interruptible path — a stuck OPFS call or a `stop` message that is never read must not hold `close()` for 60 s. A test covers it if the case can be provoked; otherwise the grace is covered by a unit test.
- **The database released when `close()` resolves stays the contract.** `openLockFree()` keeps its bound under the option: waiting for the browser to release a terminated worker's open lock is what lets a new client open at once, and it is not the wait the option removes. The Safari exception (a terminated `sync` worker still running) is documented, not waited for.
- **Everything else in `close()` is unchanged:** `closeAbort`, `scheduler.shutdown`, the held write locks released after the workers are gone, `connLockPromise`, `openLockFree()` for the VFS that share storage (bounded as today), `bsq:conn` and the marker released, the `setTimeout(0)` yield.
- **Escalation.** A `close({ immediate: true })` called while a draining `close()` is already in progress makes that close immediate from that point (interrupts the statements still in flight, terminates what cannot be stopped), and returns the **same** promise. A drain-mode `close()` called during an immediate one changes nothing. A second call keeps returning the same promise object in every case.
- **Mechanism.** Reuse the interruption path a query's `signal`/`timeout` already takes (`PoolWorker.interrupt`, the abort slot under isolation, the `stop` message otherwise) rather than adding a new worker message. How the client reaches every in-flight plain query (e.g. a client-wide signal merged into each call's signal, aborted only by an immediate close) is the builder's call; `closeAbort` itself is aborted by every close and must not start interrupting plain queries under the default.
- **Stopping the drain wait.** Under the option the `scheduler.shutdown` drain must not hold `close()` for a statement that was terminated or interrupted: the leases of interrupted calls come back as their calls reject; a terminated worker's transport is poisoned with `closingError`, which settles its in-flight call.
- `PoolWorker.terminate` already writes `KILLED_SLOT` under isolation and quiesces before terminating on IndexedDB VFS; those stay as they are.

## Non-goals

- Changing the default `close()`.
- An option at `createSQLiteClient` time (the choice is made per `close()` call).
- Making the `sync` build interruptible without isolation, or working around WebKit 328618.
- A distinct error code for "interrupted by close".

## Anti-goals

- `close({ immediate: true })` hanging for `drainTimeout` on any build — that is the very thing the option exists to avoid.
- The default `close()` interrupting anything it does not interrupt today.
- A database left unopenable on Chrome or Firefox after an immediate close (a cut write is rolled back, the file reopens).

## Documentation

- `API.md`, § `close()`: the option in an option table (one line, a `[More info]` link to a `####` subsection), the two paths in consumer terms, the misreported write, the Safari limit on `sync` without isolation. § Interrupting a call and the `CLIENT_CLOSED` row of the error table mention `close({ immediate: true })`. The TSDoc on `close` in `src/api.ts` follows.
- `CHANGELOG.md`, `## [Unreleased]`, `### Added`: one entry, through the `changelog-maintenance` skill.

## Tests

Browser tests (Vitest + WebdriverIO, tagged for the planner; every bound a test writes through `scaled()`; an unreached precondition through `exercised()`):

1. **Interruptible path** (`async`/`jspi`, and `sync` under isolation): a long-running query is in flight (seen running before closing); `close({ immediate: true })` resolves well under `drainTimeout` (set `drainTimeout` high in the test, so a drain would be unmistakable), the query rejects with `CLIENT_CLOSED`, and a new client opens the same database and reads it.
2. **Non-interruptible path** (`sync` without isolation, Chrome and Firefox): same assertions; the worker is terminated rather than closed. The reopen is asserted through the library's own open (its `openTimeout` and retries, scaled as in the suite), not as a single first attempt: a terminated worker's handles are released by the browser in its own time.
3. **A cut write is rolled back:** a long write in flight, immediate close, reopen: the database is consistent and the write absent (where the statement had not committed).
4. **Escalation:** a draining `close()` held by a long query, then `close({ immediate: true })`: both return the same promise, which resolves well under `drainTimeout`.
5. **Default unchanged:** an existing drain test still drains (a plain write in flight completes and resolves).
6. A `stream()` being consumed and a `bulkWrite()` mid-load each reject with `CLIENT_CLOSED` under the option.

Unit tests where the logic is reachable without a browser (option parsing, escalation, same-promise identity).

Safari is not in the default run; the Safari limit is documented, not tested here.
