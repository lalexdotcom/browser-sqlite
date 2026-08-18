# Wave 2 — Error surface, worker lifecycle, and a real `close()`

Date: 2026-08-18
Status: approved, not yet implemented
Covers: B2, B3, second half of W-route
Context: `mem:project-state`, `mem:follow-ups`, `mem:resume-plan` §1.4, §1.5, §2 (wave 2 row)

## 1. Goal

Make every failure observable and every wait bounded.

Today the library has no failure surface at all. There is no `onerror`, no
`onmessageerror`, no timeout anywhere, and `close()` is a bare `terminate()` loop. Three
consequences, each reachable from ordinary use:

- **A dead worker hangs the caller forever.** `deferredChunk` is never settled, so the
  `while (deferredChunk) await deferredChunk.promise` drain in `pool.ts:167` never
  returns, the lease never goes back to the pool, and if the dead worker was the
  designated writer, `currentWriterIndex` (`scheduler.ts:44`) stays pinned on a corpse —
  every future write deadlocks behind it. Wave 1 closed B1's second half by *adding* that
  drain wait and recorded the dependency in the code: the wait is correct only once
  something bounds it.
- **A failed open is reported as success.** `open()`'s `.finally()`
  (`worker/worker.ts:144-151`) posts `ready` whether the database opened or not, and
  `deferredInit` (`pool.ts:46`) has no rejection path at all. A database held under an
  exclusive lock by another tab therefore produces a pool of workers that answer `ready`
  and fail every query.
- **A misconfigured consumer reads nothing.** A Vite consumer whose worker URL 404s gets
  silence, not an error (VIT-1, observed from the outside during wave P). D6 §1.4 item 4
  made the actionable message an explicit requirement of this wave.

A fourth item rides along because it is the same subject — API strictness at the routing
boundary: `read()` currently runs a write query silently instead of rejecting it
(W-route, second half).

## 2. Non-goals

- **No back-pressure.** BP-1 is wave 4. This wave presumes death by timeout precisely
  because the worker cannot be observed during a query; see §5.3.
- **No `navigator.locks`.** The init mutex stays a `SharedArrayBuffer`. Wave 3 brings the
  primitive in with D3.
- **No debug wiring.** D5 is wave 3. The debug hooks in `pool.ts:67-74` stay `undefined`.
- **No `db.ready` promise.** A fatal init failure surfaces on first use, not at
  construction. Adding a readiness handle is new public API nobody has asked for.
- **No retry of a failed request.** Ever. See R6 in §4.2.
- **No pragma allowlist.** B4 is wave 3 — but this wave creates an obligation on it, see
  §7.3.

## 3. Decisions

| # | Question | Decision |
|---|---|---|
| W2-1 | What happens to the pool when a worker dies? | Evict, then restart the slot, bounded by `maxWorkerRestarts` (default 1). Pool empty ⇒ the client fails permanently. |
| W2-2 | What is bounded, and by default? | Two internal bounds only — `openTimeout` and `drainTimeout`. No per-request timeout: `AbortSignal.timeout()` already gives the caller a full wall-clock bound. |
| W2-3 | What does `close()` mean? | Graceful drain. In-flight requests finish, queued requests reject, then a per-worker `close` handshake calls `sqlite.close(db)`. Bounded by `drainTimeout`. |
| W2-4 | How strict is read routing? | All four read-shaped methods (`read`, `chunk`, `stream`, `first`) reject a statement not provably a read. `write()` routes to the writer unconditionally. |
| W2-5 | What shape do the new errors take? | One exported class, `SQLiteError`, carrying a `code` discriminant. |

### 3.1 The three new client options

| Option | Default | Meaning |
|---|---|---|
| `maxWorkerRestarts` | `1` | Restarts allowed per slot before it is evicted permanently (§4.2). |
| `openTimeout` | `30_000` ms | Per slot, measured from its `open` message, until it reports `ready` (§5.1). |
| `drainTimeout` | `60_000` ms | Bounds the stop-and-drain wait and the `close()` handshake (§5.2, §6). |

No per-request option is added; see §5.4.

### 3.2 Why restarts are bounded by a slot counter, and not by anything else

Three rules make `maxWorkerRestarts` a real bound rather than a decoration. Each exists
because of a specific failure mode, and none is optional.

**R1 — a slot that has never reported `ready` is never restarted.** An initial creation
failure is deterministic: a 404 worker URL, a missing COOP/COEP header, an unsupported
VFS. Restarting it delays exactly the diagnostic this wave exists to deliver, and it does
so `poolSize × maxWorkerRestarts` times over.

There is a second, *dated* justification for R1, recorded here so a later wave can tell
which half expired. `WorkerOrchestrator.lock()` (`orchestrator.ts:116-127`) is an
unbounded `Atomics.wait` loop, and the matching `unlock()` runs in the `finally` of the
worker's `open()`. A worker that dies *during* its init therefore leaves `INIT_LOCK` at
`LOCKED` forever, and a replacement would block inside `Atomics.wait` — on its own thread,
with no way to report the timeout. A worker that has reached `ready` has already released
the lock, so its replacement takes it normally. **This half of the rationale expires when
`navigator.locks` replaces the init mutex (wave 3): the browser releases a lock whose
holder is gone. The first justification does not expire — do not reopen R1 on the strength
of the lock change alone.**

**R2 — the restart counter resets on a request served, not on `ready`.** The failure mode
this defeats is "boots fine, dies on every query": with a reset on `ready` the counter
returns to zero at every restart and the loop is infinite and silent. Resetting only after
the replacement has actually completed a request makes the bound real.

**R6 — the in-flight request is never replayed.** A statement that kills its worker (OOM
on a huge result set, a WASM trap) would otherwise be replayed `maxWorkerRestarts` times,
killing a fresh worker each round. The request rejects; only the *slot* restarts.

The option is named `maxWorkerRestarts`, not `maxRetries`, because nothing is retried.

## 4. Failure detection and the supervisor

### 4.1 Three signals, one of which does not mean death

| Signal | What it catches | Worker actually dead? |
|---|---|---|
| `worker.onerror` | uncaught error in the worker, **and** script load failure | yes |
| `worker.onmessageerror` | an inbound message could not be deserialized | **no** — the worker is alive, only the message is lost |
| an internal timeout expiring | silent death (killed by the browser, thread gone without an event) | presumed |

`onmessageerror` is the odd one. The in-flight request can never settle — its chunk is
gone — so it rejects with `PROTOCOL_ERROR`, but the worker stays in the pool and returns
through the ordinary stop-and-drain. It is the only path that rejects a request without
killing a worker.

Silent death produces no event of any kind. Only a timeout catches it, which is why §5
keeps two internal bounds even though the caller has `AbortSignal.timeout()`.

### 4.2 `supervisor.ts` — a new pure module

The restart policy is state, and state that decides. Testing it through the browser would
repeat exactly the mistake that let B1 live for months, so it follows the wave 1 pattern:
no `Worker`, no DOM, no orchestrator import; events in, decisions out.

```
supervisor.report(index, 'ready' | 'served' | 'died')  ->  'restart' | 'evict' | 'fail-client'
```

Rules, all unit-tested in Node:

- **R1** — `died` on a slot that has never reported `ready` ⇒ `evict`, never `restart`.
- **R2** — `served` resets that slot's restart counter. `ready` does **not**.
- **R3** — `died` on a slot below `maxWorkerRestarts` ⇒ `restart`, counter incremented.
- **R4** — restarts exhausted ⇒ `evict`, permanently.
- **R5** — an `evict` that leaves zero live slots ⇒ `fail-client`.
- **R6** — no decision ever concerns the in-flight request. It always rejects.

`pool.ts` executes the decision; it does not take it.

### 4.3 What the scheduler gains

Still pure, still driven by Node tests:

- **`remove(index)`** — drops the worker from `workers` and from `available`, clears
  `currentWriterIndex` if it pointed there, and marks the index dead so a late
  `release()` becomes a no-op. This last part is what makes death safe: the lease holder
  is blocked on a chunk, we reject their promise, their `finally` calls `release()` — and
  that call must not put a corpse back into the pool. `remove()` also clears any lease
  outstanding on that index from the accounting below, so a client that is failing does
  not wait on leases nobody can return.
- **`shutdown(reason)`** — rejects every queued waiter and makes every later `acquire()`
  reject with `reason`. It is the common floor for "pool empty" (§4.2 R5) and for
  `close()` (§6). It returns a promise that settles when the last outstanding lease has
  come back, which §6 step 2 consumes.
- The wait queues store `{ resolve, reject }` instead of the bare `resolve` of
  `scheduler.ts:127-128`.

`add(worker)` needs no change: it already writes `workers[worker.index]` and serves the
queues, so a restart is an `add` at the same index.

### 4.4 Slots are identified by index, and the index is reused

`createPoolWorker` currently derives the index from `pool.push(...) - 1`
(`pool.ts:50-63`). A restart must reuse the dead slot's index — the orchestrator's status
byte, the `pool` array cell and the writer designation are all index-keyed — so the
function takes the index as a parameter instead of computing it.

### 4.5 Two limits documented rather than solved

1. **A transaction whose worker dies rejects, and its SQLite connection goes with it.** If
   the OPFS VFS held a file lock, releasing it depends on the browser reclaiming the
   terminated worker's handle; we have no lever on that. Recorded in `transaction()`'s
   JSDoc.
2. **`createSQLiteClient` stays synchronous.** A fatal init failure surfaces on the first
   call, through `scheduler.shutdown(error)`, which makes every method reject with the
   original error. As a side effect this fixes a real defect: the pool init chain
   (`client.ts:431-444`) is currently floating, so any rejection there becomes an
   unhandled rejection today.

## 5. The bounds

### 5.1 `openTimeout` — default 30 s, configurable

Bounds "this worker never said `ready`". The timer is per slot and starts when its
`open` message is posted. The case that matters is not the 404 —
`onerror` reports that immediately — but a database held under an exclusive lock by
another tab, where the worker blocks inside `open_v2` forever.

On expiry, slots that never reached `ready` are terminated and evicted (never restarted:
R1). Slots that are ready keep serving. The client dies only if the count reaches zero,
and the resulting `TIMEOUT` error names both the attempted worker URL and the probable
cause.

**`INIT_LOCK` is not broken when a stuck worker is evicted.** The lock is a boolean; it
does not say who holds it, and freeing it while another worker is legitimately inside
`open_v2` reopens the very race the lock exists to prevent. Accepted consequence: a worker
that dies holding the lock sterilises the other slots' init, which then time out in turn.
This is repaired for free in wave 3 — the browser releases a `navigator.locks` lock whose
holder is gone. Expected benefit, not debt.

### 5.2 `drainTimeout` — default 60 s, configurable

Bounds the drain loop of `pool.ts:167`. On expiry: presumed death — terminate, evict,
and restart per §4.2.

### 5.3 Why the default is generous

**During a query, nothing distinguishes a dead worker from a live but slow one.** The
worker's row loop is an unbroken chain of `await sqlite.step()`; it never returns to its
event loop, so no heartbeat can arrive — and its status byte in the SAB does not move
either, a corpse leaves the same value as a live worker. A single `step()` can be very
long: an `ORDER BY` over millions of rows sorts entirely inside the *first* `step()`
before returning a row.

A tight default would therefore terminate workers that are doing their job, which the
project's standing rule forbids when a non-destructive path exists. Making liveness
observable is BP-1 in wave 4: a credit/ack per chunk returns the worker to its event loop.
Wave 2 can only presume.

### 5.4 No per-request timeout

Wave 1 put `signal` on every method, so `AbortSignal.timeout(n)` already gives the caller
a native wall-clock bound, and §5.5 makes the whole path bounded end to end. A
`timeout?: number` option would be a second mechanism doing the same job less well, on
public surface W-types already calls too wide.

Documented cost: worst case, the call returns after the signal's delay **plus** the drain
— except that §5.5 removes the drain from the caller's wait entirely.

### 5.5 An abandoned request must not cost a healthy worker

Two corrections, both required, and both revealed by the long-`ORDER BY` case:

**(i) Abort returns promptly.** `chunk()` tests `aborted` only *after* a chunk arrives
(`queries.ts:28-33`). While the worker sorts, a caller who aborts stays blocked on their
`await` until the first row — so `AbortSignal.timeout(5000)` does not return in 5 s. The
pending-chunk promise is therefore raced against the abort event, and the rejection leaves
at the instant the signal fires. The race lives in a helper shared by `chunk()` and
`writeWorker()`, preserving the property that `queries.ts` is the only module that reads
an `AbortSignal`.

**(ii) The caller no longer awaits the drain.** The lease returns to the pool when the
worker confirms it is idle — wave 1's invariant is preserved, a worker still inside
`step()` cannot be re-lent — but it is the *end of the drain* that returns it, not the
caller's `finally`. The caller resumes immediately.

`drainTimeout` therefore stops meaning "how long the caller waits" and starts meaning
"when do we give up on a slot nobody is waiting for". It can be generous without
penalising anyone, and it will not terminate a worker whose result someone still wants. An
abandoned request costs at most one pool slot, temporarily, until the sort finishes; with
`poolSize: 1` the next call simply queues behind it, which is correct.

Mechanically: `release()` stays idempotent and the call site stays `client.ts`'s
`finally`, but it chains on the quiesce promise exposed by the transport instead of firing
immediately. That promise must be caught — an abandoned drain that rejects must not become
an unhandled rejection.

## 6. `close()`

`close(): Promise<void>`, idempotent — a second call returns the same promise. The
signature change from `() => void` is a break, free under the standing no-consumer
assumption.

1. **`scheduler.shutdown(new SQLiteError('CLIENT_CLOSED'))`** — queued waiters reject at
   once, and every later `acquire()` rejects the same way. One call closes the front door
   for all methods; no method needs its own guard.
2. **Wait for outstanding leases**, via the promise `shutdown()` returns. "Returned" now
   means "the worker confirmed idle" (§5.5 (ii)), so the two mechanisms compose with no
   extra code.
3. **Per-worker handshake** — post `close`, the worker calls `sqlite.close(db)`, replies
   `closed`, and is terminated. This is the only place the database is actually closed:
   `sqlite.close` is called nowhere today and is missing from the hand-written subset in
   `wa-sqlite.d.ts`, where it is added.
4. **Bounded by `drainTimeout`** — on expiry, terminate without waiting.

Two edge cases, settled:

- **`close()` during an open transaction.** A transaction's lease is held by user code,
  not by a worker wait, so step 2 would never complete if the callback never returns. It
  is bounded like the rest, and on expiry we terminate. Nothing is lost by halves: a
  transaction that never committed is discarded with its connection.
- **`bulkWrite` in flight.** It goes through the public `write()`, hence through a lease:
  the batch in flight finishes, later batches reject with `CLIENT_CLOSED`. The "in flight
  yes, queued no" rule applies with no special handling.

## 7. Routing strictness and the error surface

### 7.1 `SQLiteError`

One exported class. `code` is the discriminant, `name` mirrors the code so `err.name`
reads the way `'AbortError'` does (wave 1 rethrows `signal.reason`, and consumers should
not need two idioms), and `cause` carries the original error.

| Code | Raised when | Worker survives? |
|---|---|---|
| `NOT_A_READ_QUERY` | a read-shaped method is handed a statement not provably a read | n/a |
| `CLIENT_CLOSED` | any call after `close()`, and waiters queued at `close()` time | n/a |
| `WORKER_CRASHED` | in-flight request on a dead worker; also the load failure, with the actionable message | no |
| `TIMEOUT` | `openTimeout` expired with no worker ready; served thereafter to every call | no |
| `PROTOCOL_ERROR` | `onmessageerror` | **yes** |

The load-failure message names the URL that was attempted and points at the README's
Bundler Configuration section. That is what turns VIT-1 from "hangs forever" into "reads
an error", per D6 §1.4 item 4.

### 7.2 Strictness

`read`, `chunk`, `stream` and `first` throw `NOT_A_READ_QUERY` **before acquiring a
lease**, so a rejected statement costs no pool capacity. The check is factored into one
place — `client.ts` currently repeats the same `isReadQuery(sql) ? 'read' : 'write'` line
at four sites — and `write()` loses its ternary to acquire `'write'` unconditionally.

`chunk` and `stream` are async generators, so their throw surfaces on the first `next()`,
not at the call. Recorded in their JSDoc rather than reshaping them.

### 7.3 The PRAGMA regression, and the obligation it creates

`isReadQuery` classifies every `PRAGMA` as a write (`utils.ts:31`), so
`db.read('PRAGMA table_info(t)')` — which returns rows — starts rejecting, where today it
runs silently on the writer. The escape hatch is `db.write(...)`.

**B4's read-pragma allowlist (wave 3) must return those statements to `read()`.** This is
recorded as an obligation in B4's entry in `mem:follow-ups`, not only here, so wave 3
cannot lose it.

## 8. Protocol changes

`types.ts` gains three messages:

- client → worker: `{ type: 'close', callId: 0 }`
- worker → client: `{ type: 'closed', callId: 0 }`
- worker → client: `{ type: 'open-error', callId: 0, message, cause? }`

`open()` stops posting `ready` from a `.finally()` (`worker/worker.ts:144-151`): `ready`
on success, `open-error` on failure.

**Causes are degraded defensively.** The error reply posts `e.cause` as-is today
(`worker/worker.ts:235`). If the cause is not structured-cloneable, the `postMessage`
itself throws — inside the `catch` — so the client receives *nothing* and waits forever.
Every cause crossing the boundary is probed and falls back to text.

Both message-union dispatches gain `default: const _x: never` exhaustiveness. The unions
grow in this wave; that is the moment to make an omission impossible.

## 9. Testing

**The standing lesson applies to every test written here: for each one, name the line
whose deletion makes it fail.** Seven wave 1 tests passed identically with and without the
behaviour they claimed to pin, and this is the habit that caught them.

### 9.1 Node — the pure modules only

No fakes of the browser, no simulated transport. Only logic that never needed a browser:

- **`scheduler`** — `remove()` clears availability and the writer designation; a late
  `release()` on a dead index is a no-op; `shutdown()` rejects queued waiters and later
  acquisitions; the promise it returns settles on the last lease.
- **`supervisor`** — the six rules of §4.2. The decisive one is R2: a slot that boots
  fine and dies on every request must stop, not loop.

### 9.2 Browser — everything else, on real workers

Production code gains no test seam. The tests intercept `globalThis.Worker` with a
subclass that records its instances before the client is created, which gives real
conditions and real SQLite:

- **silent death** — `instance.terminate()` from the test: no event at all, the case only
  `drainTimeout` catches.
- **uncaught error** — `instance.dispatchEvent(new ErrorEvent('error', …))`, reaching our
  `onerror` by the real path.
- **load failure** — an instance built on a deliberately wrong URL: a real 404 and a real
  `ErrorEvent`, so B2's actionable message is tested for real rather than simulated.
- **`onmessageerror`** — `dispatchEvent(new MessageEvent('messageerror'))`. This one stays
  synthetic and the test says so: producing a genuinely undeserializable message on demand
  is not achievable cleanly.
- **restart policy end to end** — kill, observe the replacement serve a query, kill again
  past `maxWorkerRestarts`, observe permanent eviction and then a failed client.
- **real `open-error`** — two clients on the same file under `AccessHandlePoolVFS`: the
  exclusive-lock failure the `.finally()` masks today.
- **`close()` really closes** — `sqlite.close(db)` reached, later calls reject
  `CLIENT_CLOSED`, in-flight write completes, queued write rejects.
- **routing strictness** — four methods, plus the PRAGMA regression asserted explicitly so
  wave 3 sees it turn red when B4 lands.
- **the long query** — a `WITH RECURSIVE` of a few million iterations gives one very long
  `step()` with no table to populate. Three assertions: it runs to completion untouched;
  an abort returns promptly instead of waiting for the first row (§5.5 (i)); and the
  abandoned worker is **not** terminated — it rejoins the pool when its sort ends
  (§5.5 (ii)).

These tests need `openTimeout` and `drainTimeout` set low. Those are the §5 options,
public and justified on their own merits — not test scaffolding.

### 9.3 Regression sweep

Strictness will break existing tests that hand a `PRAGMA` or a write statement to
`read()`. Expect to touch several files under `tests/browser/`.

## 10. Sequencing

Pure modules first, transport second, semantics last — so a wiring bug stays
distinguishable from a policy bug.

1. `SQLiteError` + the three protocol messages + exhaustive dispatch (no behaviour change).
2. `scheduler`: `remove()`, `shutdown()`, `{resolve, reject}` queues — with its Node tests.
3. `supervisor.ts` — with its Node tests. Nothing consumes it yet.
4. `createPoolWorker` takes an explicit index. Pure refactor.
5. `onerror` / `onmessageerror` wired to the supervisor; crash path, eviction, restart.
6. `openTimeout`, `drainTimeout`, and the `open-error` reply.
7. §5.5 (i) prompt abort and (ii) asynchronous quiesce.
8. `close()` handshake, worker side and client side, plus `sqlite.close` in the `.d.ts`.
9. Routing strictness + the regression sweep.
10. JSDoc, README, memories.

## 11. Definition of done

On top of the standing three (CI green, memories updated, git clean):

1. No wait in the library is unbounded: init, drain, and close all have a timeout, and the
   caller's own bound is `AbortSignal.timeout()`.
2. A killed worker rejects its in-flight request and restarts once by default; killed
   twice in a row without serving anything in between, it is evicted permanently.
3. A load failure produces an error naming the URL, verified against a real 404.
4. `close()` reaches `sqlite.close(db)`, lets an in-flight write finish, and rejects a
   queued one.
5. The four read-shaped methods reject a write statement before taking a lease.
6. The long-query test passes: not killed, abort prompt, worker not terminated.
7. The browser suite exits on its own — no worker handle keeps the process alive. This is
   the concrete signal that B2's hang is gone; wave 1 had to bound its verification
   commands with `timeout -k 30` because of it.

## 12. Recorded for later waves

- **R1's second justification expires with wave 3** (§3.2). The rule itself does not.
- **`INIT_LOCK` is deliberately never broken** (§5.1); `navigator.locks` removes the need.
- **BP-1 (wave 4) is what makes liveness observable** (§5.3). Until then every drain
  bound is a presumption, and `drainTimeout` can only be generous.
- **B4 (wave 3) owes `read()` its read pragmas back** (§7.3).
