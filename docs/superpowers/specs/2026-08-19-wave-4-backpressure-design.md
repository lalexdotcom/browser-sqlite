# Wave 4 — BP-1: back-pressure on `chunk()` / `stream()`

**STATUS: DRAFT — brainstorming in progress. Last updated 2026-08-20.**

Sections 1 (the mechanism) and 2 (scope and the `SharedArrayBuffer`) are
**approved by the user**. Sections 3 (failure modes) and 4 (testing) have not
been presented yet. Do not implement from this document: it is a checkpoint, not
a spec. The remaining sections are listed in §7 with the notes already gathered
for them, so the conversation can resume without re-deriving anything.

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

## 3. The mechanism (section 1 — APPROVED)

### 3.1 Worker side

A `credits` counter, a signal deferred that every incoming credit message
resolves and swaps, and a `tick()` built on a `MessageChannel` posting to
itself. Before emitting each chunk:

```
await tick();                                   // unconditional task turn
while (credits <= 0) await creditSignal.promise; // back-pressure
credits -= 1;
```

`MessageChannel`, not `setTimeout`: nested `setTimeout` is clamped to 4 ms,
which would cost seconds over a few hundred chunks.

### 3.2 The initial window travels in the `query` message

Not as separate credit messages. This removes the deadlock of §2.3 by
construction — no credit can arrive before the worker is able to wait for one.
Afterwards, one credit message per chunk.

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
  ceasing work. See §3.6 for what bounds a tick.

### 3.6 The tick fires on a row counter too, not only per chunk

Amendment made on 2026-08-20, while taking the inventory for §4. It corrects a
claim in the approved §3: "bounded by one chunk" holds only if chunks are
actually produced.

`SELECT * FROM huge WHERE never_true` steps millions of rows without ever
filling a buffer. No chunk, therefore no tick, therefore the `stop` message is
never delivered: the worker runs to the end and the drain expires on
`drainTimeout`, so a perfectly healthy worker is presumed dead and restarted.
**Today that query aborts cleanly**, because the `ABORTING` flag is re-read on
every row. That would be a plain regression, not a known residual.

So the tick also fires on a **row counter** — at least one tick every N rows
stepped, N on the order of 1000. Cost: a 1M-row filtering scan is 1000 ticks,
9-14 µs each, so 9-14 ms. This reinforces §2.3's lesson: the tick serves
liveness, the credit serves memory, and the two counters have no reason to be
coupled.

## 4. Scope, and removing the `SharedArrayBuffer` (section 2 — APPROVED)

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

## 5. What this does NOT fix

A query that spends its whole life inside a single `step()` — a large
`ORDER BY`, a recursive CTE — produces no chunk, therefore no tick, therefore no
deliverable abort. **BP-1 narrows B2's residual; it does not remove it.** After
wave 4 the residual reads: *a worker that dies inside one long `step()` is
noticed only if the caller aborts.* This matches what `mem:follow-ups` already
predicted for BP-1 and must be carried into the README and B2's entry.

## 6. Cost summary

At the default `chunkSize` of 500, a 1M-row `read()` is 2000 chunks, so roughly
20-30 ms of added tick cost over the whole query. The §2.2 run is deliberately
pathological — 4000 chunks of 50 rows — to make a per-chunk cost visible at all.

## 7. Open — not yet presented to the user

**Section 3: failure modes.** Notes already gathered:
- The stop flag must be tested **before** the credit wait, or a stopped worker
  blocks forever waiting for a credit that the unwinding client will never send.
  This is the interaction between the new wait and the wave-2 stop-and-drain.
- A worker blocked on a credit is, for the first time, able to receive `close`
  mid-query. That is an improvement over today, where a worker inside a query
  cannot be closed — worth an explicit test.
- Worker death while the client waits for a chunk is already covered by
  `deathDeferred`; confirm the new wait does not bypass it.

**Section 4: testing.** The falsifiability requirement is known in advance: a
test must fail if the tick is removed. §2.2's counter-only control is the shape
to reuse — assert that an abort posted mid-query is observed within one chunk,
which is exactly what regresses to batch-size latency without the tick.

**Not in this document, and still owed by wave 4:** the commit-propagation
barrier (RYOW-1, the writer designation's stickiness, the two tests pinned to
`poolSize: 1`) and D6 (the `browser-sqlite/vite` subpath). Both come after BP-1
and D2; the barrier deserves its own brainstorming, and its options may depend
on what BP-1 leaves behind.
