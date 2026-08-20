## Task 4 Report

**Status:** DONE

**Commit:** `6cbce5b`

**Test summary:** 289/289 pass, 0 failures.

**What was done:**

- `src/worker/worker.ts`: added `queryRunning` deferred + `idleUntilQueryEnds()` helper;
  arms the deferred beside `gate.reset()` in `case 'query'`, settles it in the `finally`;
  replaced `case 'close'` to call `gate.stop()`, await the deferred, then close.

- `src/client.ts`: before `await bounded(draining, drainTimeout)`, sends `{ type: 'stop' }`
  to every worker (not `close`). Streaming queries break out of the next `gate.take()` tick,
  releasing their leases so draining resolves without hitting the timeout. Writes are unaffected:
  they never call `gate.take()` and `gate.reset()` at query start clears the flag anyway.

- `tests/browser/backpressure.test.ts`: appended the `close() during a query` describe block.

**Root-cause of the regression that required the client.ts change:**

Sending `worker.close()` (not `stop`) early meant the `close` message arrived at the
worker BEFORE the `query` message — because `query` is dispatched via microtask (lease
acquisition) while `close` was sent synchronously. The worker then called `sqlite.close(db)`
before the INSERT had a chance to use the database → SQLITE_MISUSE. Using `stop` is safe
because `gate.reset()` in `case 'query'` undoes it if it races ahead, and `stop` never
touches the database.

---

## Fix Round 1 Report

**Status:** DONE

**Three-part change:**

### Part 1 — Revert `src/client.ts`

Removed the stop-broadcast loop (comment + `for (const w of pool) w.postMessage({ type: 'stop', ... })`)
from `close()`. The function now goes directly from `scheduler.shutdown()` to
`await bounded(draining, drainTimeout)`, restoring the wave-2 "drain in-flight work, bounded by
drainTimeout" contract.

### Part 2 — Close the truncation hole

**`src/worker/worker.ts`:**
- Added module-level `let closing = false;`
- In `case 'close'` (post-open handler): set `closing = true;` before `gate.stop()`
- In `case 'query'` handler: replaced `reply({ type: 'done', callId, affected })` with an
  if/else that sends `{ type: 'error', message: 'The SQLite client has been closed.' }` when
  `closing` is true, and `done` otherwise. This distinguishes a close-induced stop (should
  reject) from a client-initiated drain stop (should resolve).

**`src/pool.ts`** (second hole, not mentioned in the ruling but required for correctness):
The worker-side fix sends `error` instead of `done`. However, pool.ts's `case 'error'` handler
was nulling `deferredChunk` before the generator could read it. When the consumer is sleeping
(suspended at `yield`), the generator is NOT awaiting `Promise.race([deferredChunk.promise, ...])`;
it's parked at `yield`. Nulling `deferredChunk` caused `while (deferredChunk)` to exit normally
on resume — identical silent truncation.

Fix: in `case 'error'`, do NOT set `deferredChunk = undefined`. Leave the rejected promise in
place so the generator throws on the next `await Promise.race([deferredChunk.promise, ...])`.
Also attach `deferredChunk.promise.catch(() => {})` to suppress the unhandled-rejection warning
that the browser fires when no handler is attached within the same microtask (the consumer may
be asleep for up to 5ms). The generator's `finally` sets `deferredChunk = undefined`
unconditionally, so cleanup is unaffected.

**Client-initiated drain path is unchanged:** When pool.ts's `finally` sends `stop` itself,
`closing` is false (the worker's `close` handler hasn't fired yet, or the stop arrives before
the close), so the worker replies `done`, `deferredChunk.resolve(affected)` fires normally,
and the drain loop exits as before.

### Part 3 — Fix test assertions

In `tests/browser/backpressure.test.ts`, `close() during a query` describe block:
- `drainTimeout: 2000` → `drainTimeout: 300` (close is bounded, not fast; 300ms is enough)
- `expect(performance.now() - started).toBeLessThan(2000)` → `toBeLessThan(3000)` (bounds the
  wave-2 drain contract, not the old stop-broadcast shortcut)
- `await streaming;` → `expect(await streaming).toBe('rejected');` (the assertion that actually
  pins the fix — this is what the prior test was missing)
- Falsifiability comment updated: "without the `closing` check in the worker's query handler,
  the in-flight stream resolves with a partial result instead of rejecting, and the
  `toBe('rejected')` assertion below is what catches it."

### Falsifiability verification

**Probe run (closing check replaced with always-done):**

```
status: fail
tests: 6, failedTests: 1
close() during a query > stops the query first, then closes — FAIL
AssertionError: expected [ 1, 3, 4, 5, … (60 rows) ] to be 'rejected'
```

The test caught silent truncation: the stream resolved with 68 partial rows instead of rejecting.

**Restored run:**

```
status: pass
tests: 6, failedTests: 0
```

All tests pass, including `close() during a query > stops the query first, then closes`.

### Final test run

```
pnpm check && pnpm exec tsc --noEmit && pnpm test
```

Result: **289/289 pass, 0 failures.** `tests/browser/close.test.ts` (5 tests) all green —
wave-2 close handshake is intact.
