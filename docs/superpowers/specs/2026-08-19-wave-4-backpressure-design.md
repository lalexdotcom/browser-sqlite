# Wave 4 — BP-1: back-pressure on `chunk()` / `stream()`

**STATUS: complete, awaiting user review. 2026-08-20.**

All four brainstorming sections are approved: the mechanism (§3), scope and the
`SharedArrayBuffer` removal (§4), failure modes (§5), and testing (§6). The next
step after review is the implementation plan, via the writing-plans skill.

Scope note: this document covers **BP-1 and D2 only**. Wave 4 also owes the
commit-propagation barrier and D6; both come after, and the barrier deserves its
own brainstorming — see §9.

Branch: `feat/wave-4-backpressure`, from `main` at `c07c92f`.

## 1. Why BP-1 exists, and what it gates

The worker posts chunks as fast as it can produce them and nothing throttles it.
That is not an optimisation defect — it blocks three separate things that were
written down in three places without knowing they were linked:

- **D2 / W-sab.** Awaiting a client credit per chunk is what returns the worker
  to its event loop, and therefore the only thing that makes the `ABORTING` flag
  replaceable by `postMessage`. Removing only the init mutex banks none of D2's
  benefit, so the whole `SharedArrayBuffer` — and with it the COOP/COEP
  requirement imposed on every consuming application — depends on this.
- **`first()`'s hard bound.** Today the worker races ahead between the first row
  and the client's abort-flag write. With credits it costs exactly one row.
- **The memory guarantee the README already advertises.** Unbounded chunk
  pile-up contradicts it. The guarantee is currently false.

## 2. Two measurements, and what they settled

Both were run on this branch and reverted; they live in git history only. Do not
re-run them.

### 2.1 Is a `postMessage` delivered to a worker mid-query? (commit `dc96f57`)

`mem:resume-plan` §1.5 asserted it is not. That was reasoned, never observed,
and doubtful for the default VFS, which runs wa-sqlite's Asyncify build and
unwinds the WASM stack around asynchronous VFS calls.

| VFS | load | channel OK | query | pings | handled in query | handled after |
|---|---|---|---|---|---|---|
| `OPFSPermutedVFS` (Asyncify) | CPU | yes | 5160 ms | 206 | **0** | 206 |
| `OPFSPermutedVFS` (Asyncify) | I/O | yes | 1063 ms | 42 | **0** | 42 |
| `OPFSCoopSyncVFS` (sync) | CPU | yes | 4116 ms | 164 | **0** | 164 |
| `OPFSCoopSyncVFS` (sync) | I/O | yes | 1126 ms | 44 | **0** | 44 |
| `OPFSAdaptiveVFS` (JSPI) | CPU | yes | 4122 ms | 165 | **0** | 164 |
| `OPFSAdaptiveVFS` (JSPI) | I/O | yes | 1291 ms | 52 | **0** | 51 |

Two controls make the zero mean anything, and the first attempt had neither: a
ping sent while the worker is idle always comes back, so the channel works; and
every ping sent during a query is handled immediately after it, so the messages
queue rather than being lost.

The JSPI rows were added on 2026-08-20 (commit `df73833`, reverted in `fd03788`).
They close the last gap: the claim had been verified on two of wa-sqlite's three
WASM builds, and JSPI is not a variant of Asyncify — it suspends by integrating
with real promises rather than unwinding to a JS trampoline, so it was the one
that could plausibly yield on its own. It does not.

**§1.5 is confirmed.** No task turn happens on its own, on any of the three
builds, under either load.

### 2.2 Does creating a task turn restore delivery? (commit `fae6423`)

Measured on the real row loop and the real VFS, 4000 chunks (200k rows,
`chunkSize` 50), three passes each.

| mode | median | abort latency |
|---|---|---|
| baseline, no back-pressure | 338 ms | **never delivered** |
| tick + credit, window 1 | 393 ms | 0 chunks |
| tick + credit, window 2 | 377 ms | 1 chunk |
| tick + credit, window 4 | 373 ms | 0-1 chunks |
| tick + credit, window 16 | 378 ms | 0-1 chunks |
| counter only, batches of 16 | 340 ms | **14 chunks** |

- **M1.** With a task turn per chunk, an abort posted mid-query is handled
  before the next chunk.
- **M2.** The counter-only control is handled as late as the batch size, so the
  task turn is load-bearing and the implementation condition is falsifiable by a
  test rather than asserted in a comment.
- **M3.** Credits are free (340 vs 338 ms); the tick is the entire cost, 9-14 µs
  per chunk. A window of 2 recovers the round-trip lockstep pays; beyond 2 there
  is no gain.

### 2.3 The design error these caught

The first proposal was: *the worker awaits one credit message per chunk, so the
await is both the accounting and the yield — no counter needed.* It deadlocks,
and the probe found it by hanging. Credits sent ahead are dispatched during the
query's start-up awaits, each resolving a signal nobody is waiting on; the
worker then awaits a fresh signal that never comes.

**Accounting and yielding are two roles.** The counter serves the first, an
unconditional task turn the second. Neither substitutes for the other.

## 3. The mechanism

### 3.1 Worker side

A `credits` counter, a signal deferred that every incoming credit message
resolves and swaps, and a `tick()` built on a `MessageChannel` posting to
itself. Before emitting each chunk:

```
await tick();                          // unconditional task turn
while (credits <= 0 && !stopped) {     // back-pressure
  await creditSignal.promise;
}
if (stopped) return;                   // §5.1 — stop also wakes this wait
credits -= 1;
```

The `&& !stopped` and the `return` are not defensive extras: without them a
stopped worker waits forever for a credit the unwinding client will never send,
and `first()` kills its worker on every call. See §5.1.

`MessageChannel`, not `setTimeout`: nested `setTimeout` is clamped to 4 ms,
which would cost seconds over a few hundred chunks.

### 3.2 The initial window travels in the `query` message

Not as separate credit messages. This removes the deadlock of §2.3 by
construction — no credit can arrive before the worker is able to wait for one.
Afterwards, one credit message per chunk.

**Every credit carries the `callId` of the query it belongs to**, and the worker
ignores any credit whose `callId` is not the current one. The counter is also
reset at the start of each query. Both are needed, for different leaks — see
§5.4.

### 3.3 The client credits on consumption, not on arrival

The credit is posted when the **consumer** has taken the chunk — after the
`yield` in `pool.ts`'s query generator, not when the `chunk` message is
received. Crediting on arrival would defeat the whole mechanism: the worker
would run at full speed and the chunks would pile up in the message queue, which
is precisely the guarantee being fixed.

### 3.4 Window default: 2, internal constant

Not a public option. The measurement shows 377 ms at 2 against 373 and 378 at 4
and 16 — nothing to tune beyond 2, and an option with no use is surface to
maintain. Window 1 costs 4 % more, which does not buy back the simplicity.

### 3.5 Decided without asking, with the reasoning

- **Back-pressure applies to every query path, `read()` included**, even though
  `read()` accumulates everything anyway. The reason is not memory: D2 removes
  the `SharedArrayBuffer`, so `read()`'s abort must travel by message, so
  `read()` needs the tick like everything else.
- **Abort granularity drops from "between two `step()` calls" to "between two
  ticks".** Real, but invisible to the caller: since wave 1, `chunk()` races the
  abort client-side and returns immediately. What is delayed is only the worker
  ceasing work. Abort latency is bounded by one **chunk** (the per-chunk tick).

### 3.6 The tick fires on a row counter too, not only per chunk

~~Amendment made on 2026-08-20, while taking the inventory for §4. It corrects a
claim in the approved §3: "bounded by one chunk" holds only if chunks are
actually produced.~~

~~`SELECT * FROM huge WHERE never_true` steps millions of rows without ever
filling a buffer. No chunk, therefore no tick, therefore the `stop` message is
never delivered: the worker runs to the end and the drain expires on
`drainTimeout`, so a perfectly healthy worker is presumed dead and restarted.
**Today that query aborts cleanly**, because the `ABORTING` flag is re-read on
every row. That would be a plain regression, not a known residual.~~

~~So the tick also fires on a **row counter**: at least one tick every **1000
rows stepped**. That constant is derived from §2.2's per-tick cost, not measured
on its own — a 1M-row filtering scan becomes 1000 ticks at 9-14 µs, so 9-14 ms,
which is negligible against such a scan. The implementation plan may revisit the
value; it must not revisit the existence of the row-counter tick. This reinforces §2.3's lesson: the tick serves
liveness, the credit serves memory, and the two counters have no reason to be
coupled.~~

**Corrected 2026-08-20:** The row-counter tick was implemented and then removed.
`gate.countRow()` was only called in the `SQLITE_ROW` branch, so it counted
**returned** rows, not stepped ones; a filtering scan returns none, so it never
fired. `ROWS_PER_TICK` (1000) also exceeds the default `chunkSize` (500), so
it could never have fired before the per-chunk tick regardless. The regression
it was invented to prevent does not exist: a filtering scan is a single long
`sqlite3_step`, meaning the old shared-memory `ABORTING` flag — read before and
after each step — could not interrupt it either. That is B2's documented
residual, already covered by §7. Abort latency remains bounded by one chunk, as
§3.5 now states.

## 4. Scope, and removing the `SharedArrayBuffer`

### 4.1 Per method

Everything funnels through `chunk()` and then `pool.ts`'s query generator, so
back-pressure is implemented once and every method inherits it. Two cases are
worth naming:

- `write()` returns rows only with `RETURNING`, so it almost never spends a
  credit. Cost nil.
- **`first()` must pass a window of 1, not 2.** `firstWorker` already sets
  `chunkSize: 1` and returns after the first row, but with a window of 2 the
  worker would produce two rows before blocking. The window is therefore a
  per-query parameter — default 2, forced to 1 by `first()` — and that is what
  delivers the exact one-row bound its JSDoc promises today without holding.

### 4.2 The 14 call sites, and what each becomes

| Site | Today | After |
|---|---|---|
| `debug.ts:176,182` | reads worker status from the SAB | a pool-local field; the pool already knows better than the SAB does (it posts the query, receives `done`, calls `interrupt`). Removes the Proxy trick. |
| `pool.ts:295` | `setStatus(ABORTING)` | a `stop` message |
| `pool.ts:362` | passes the SAB in `open` | gone |
| `client.ts:385` | `onIdle` → `setStatus(READY)` | gone |
| `worker.ts:130,155,163` | `lock`/`unlock` init mutex | `navigator.locks` (the primitive has been in `locks.ts` since wave 3) |
| `worker.ts:158,252,279` | `setStatus(READY/RUNNING/DONE)` | gone — the `ready` message already carries it |
| `worker.ts:217,220` | two `ABORTING` reads in the row loop | a local boolean set by the `stop` message |

**`orchestrator.ts` is then deleted outright, 183 lines.** It is the largest
single simplification of the wave.

### 4.3 What leaves beyond `src/`, and the acceptance test

The COOP/COEP plugin in `rstest.config.ts` — whose own comment reads "required
for WorkerOrchestrator SharedArrayBuffer construction" — the matching README
section, and the headers served by `scripts/static-server.mjs` and the two
consumer apps.

**Removing those headers and watching all 11 consumer-smoke stages still pass is
the acceptance test for D2**: it demonstrates, rather than asserts, that the
library no longer imposes cross-origin isolation on consuming applications.

Two traps not to reopen: the "Coop" in `OPFSCoopSyncVFS` means *cooperative*,
not the COOP header; and no VFS requires isolation — upstream's own comparison
table has a "No COOP/COEP requirements" row, ticked for every one of them.

### 4.4 Sequencing inside the branch

BP-1 does not need the SAB gone; D2 needs BP-1. Implement and verify BP-1
first, then D2, as two commit groups. The two mechanisms coexisting in between
is intended — it keeps a bisect meaningful.

## 5. Failure modes

### 5.1 A stop while the worker is blocked on a credit — the critical one

When a consumer leaves a `stream()` early, `chunk()`'s `finally` calls
`interrupt()` and `iterator.return()`, and `pool.ts`'s generator `finally` waits
for the worker's `done`, bounded by `drainTimeout`. But the worker is parked in
`while (credits <= 0)`, and the client has just stopped consuming, so **the
credit will never come**. The drain expires, and a perfectly healthy worker is
declared dead and restarted.

Testing the stop flag *before* the wait is not enough: the stop must also
**interrupt a wait already in progress**. The `stop` handler therefore resolves
the credit signal, the condition becomes `while (credits <= 0 && !stopped)`, and
the row loop exits when `stopped`.

This path runs on **every single `first()` call** — one row, window 1, then the
worker blocks on a credit nobody will send. Getting it wrong cannot go
unnoticed, which is why §6 pins it directly.

### 5.2 Worker death while the client waits for a chunk

Unchanged. The client-side race already includes `deathDeferred`, and the new
wait is worker-side, so it does not touch that race. To be confirmed by a test,
not modified.

### 5.3 `close()` during a query — a new capability, therefore a new risk

Today a worker inside its row loop never receives `close`; the client drains
first, then closes, bounded by `bounded(worker.close(), drainTimeout)` in
`client.ts`. With the tick, `close` becomes deliverable **mid-query** — and the
current handler calls `sqlite.close(db)` immediately. Closing a database with a
live statement returns `SQLITE_BUSY`, which the existing `catch` swallows, and
the worker replies `closed` while its loop is still running.

The `close` handler must therefore stop rather than close: set the stop flag,
let the query unwind, then close and reply. Same mechanism as §5.1, reused.

### 5.4 Credit accounting across successive queries on one worker

`transaction()` holds its lease across several queries. A credit issued for an
abandoned query can arrive after the next one has started and hand it a free
chunk, silently breaking the memory bound.

Two mitigations, both required, for two different leaks: **credits carry the
`callId`** and the worker ignores stale ones (this handles late arrivals), and
**the counter is reset at query start** (this handles credits that were granted
and never spent).

### 5.5 Worker restart

A restarted worker is a fresh `Worker`, so its module state starts clean —
nothing to do worker-side. The **client-side** bookkeeping is per slot and must
be reset with the slot, or the replacement inherits a window that has already
been spent. Handled together with the wave-2 supervisor.

### 5.6 The transverse consequence

Once §5.1 is fixed, "blocked on a credit" can never cause a drain expiry. That
is a falsifiable property, and §6 pins it.

## 6. Testing

### 6.1 The split: a pure module for the logic, the browser for the property

The credit accounting is extracted into a **pure** module, `credits.ts`:
`createCreditGate({ window, tick })` exposing `take()`, `grant(n, callId)`,
`stop()` and `reset(callId)`, with the tick **injected** (default:
`MessageChannel`).

The justification comes straight from this project's history. B1 survived for
months because the scheduler was reachable only through slow browser tests, and
wave 1 fixed that by making `scheduler.ts` pure and drivable from Node in
milliseconds. The credit logic has exactly the same profile: subtle state
transitions (§5.1, §5.4, §5.5) in a file otherwise reachable only through a
worker, a VFS and a real database.

The cost is explicit: an injected tick does not prove the real tick yields. The
logic is therefore tested in Node, the property in the browser — the same
division as `scheduler.ts` / `pool.ts`.

**Node, against the pure module:** ordering; `stop()` **waking** a wait in
progress rather than merely being tested before it; a credit with the wrong
`callId` ignored; the reset between queries; the window respected.

### 6.2 Browser — five properties, each with the line that makes it red

Stating that line is the discipline adopted after wave 1, where seven tests
passed identically with and without the behaviour they claimed to pin.

| Property | Red when |
|---|---|
| An abort posted mid-query is seen within one chunk | the tick is removed — latency falls back to batch size, exactly like the measurement's negative control |
| A filtering scan stays interruptible: it stops promptly **and** `records.length === 1` | the row-counter tick is removed — the drain expires, the worker is presumed dead and replaced, so `records.length` becomes 2. This is what guards §3.6 |
| `first()` does not kill its worker: ten calls, then `records.length === 1` | `stop` does not wake the credit wait (§5.1) |
| A slow consumer does not make chunks pile up: consume one, sleep, assert the worker sent at most `window` more, counted through `interceptWorkers` | credits are granted on arrival instead of on consumption — this pins §3.3, the easiest thing to break unnoticed |
| `close()` during a query is bounded: the in-flight caller is rejected (not handed a truncated result), and no database is closed under a live statement | §5.3 is not implemented — **corrected 2026-08-20:** the original "with no drain expiry" wording was wrong; with a slow consumer the drain legitimately runs to `drainTimeout`, which is wave 2's documented contract; the property to pin is that `close()` is bounded and callers are rejected, not truncated |

### 6.3 What is deliberately not tested

**Throughput.** No performance assertion. The numbers are in §2.2, measured
three times; a timing assertion in CI would be flaky, and this project already
spent a whole wave removing unfalsifiable assertions. The one useful temporal
guard already exists — `long-query.test.ts`'s 3000 ms bounds, which the tick's
overhead does not threaten.

**The probes.** Neither probe is kept as a test. That was decided twice, for
reasons recorded in `bbf31b9` and `d82c673`.

### 6.4 D2's acceptance

As stated in §4.3: remove the COOP/COEP headers from `scripts/static-server.mjs`
and the two consumer apps, and watch all 11 consumer-smoke stages pass. A
demonstration, not an assertion.

## 7. What this does NOT fix

A query that spends its whole life inside a single `step()` — a large
`ORDER BY`, a recursive CTE — produces no chunk, therefore no tick, therefore no
deliverable abort. **BP-1 narrows B2's residual; it does not remove it.** After
wave 4 the residual reads: *a worker that dies inside one long `step()` is
noticed only if the caller aborts.* This matches what `mem:follow-ups` already
predicted for BP-1 and must be carried into the README and B2's entry.

## 8. Cost summary

At the default `chunkSize` of 500, a 1M-row `read()` is 2000 chunks, so roughly
20-30 ms of added tick cost over the whole query. The §2.2 run is deliberately
pathological — 4000 chunks of 50 rows — to make a per-chunk cost visible at all.

## 9. Still owed by wave 4, and not covered here

Two items remain outside this document's scope: the **commit-propagation
barrier** (RYOW-1, the writer designation's stickiness, and the two browser
tests pinned to `poolSize: 1` that should go back to the default pool size once
it exists) and **D6**, the `browser-sqlite/vite` subpath with its `wasmUrl`
escape hatch.

Both come after BP-1 and D2. The barrier deserves its own brainstorming, and its
options may depend on what BP-1 leaves behind — in particular on whether the
credit channel gives the client a usable per-worker acknowledgement point.

One lead recorded on 2026-08-20 and not yet examined: `OPFSWriteAheadVFS`
implements write-ahead logging entirely inside the VFS, and a synchronous
WAL-based VFS may have quite different cross-connection visibility semantics
from `OPFSPermutedVFS`, whose asynchronous commit propagation is the cause of
RYOW-1. That is a hypothesis to measure during the barrier's brainstorming, not
a finding.
