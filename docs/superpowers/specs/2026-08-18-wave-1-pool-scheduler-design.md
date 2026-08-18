# Wave 1 — Pool, scheduler, and a single abort

Date: 2026-08-18
Status: approved, not yet implemented
Covers: B1, B9, FLK-1, W-arch, first half of W-route, part of W-types, the abort listener leak
Context: `mem:project-state`, `mem:follow-ups`, `mem:resume-plan` §1.2, §1.5, §2.2

## 1. Goal

Split the 1016-line god module, make worker exclusivity real, and implement query
cancellation exactly once.

Three defects share one root cause: the pool's scheduling state is trapped inside a
736-line factory closure, reachable only through slow browser tests. B1 survived precisely
because of that. This wave makes the scheduler a pure module a Node test can drive in
milliseconds, and relayers the query API on a single `chunk()` primitive so that abort has
one implementation instead of four.

### Why exclusivity is broken today

`worker.query()`'s `finally` (`client.ts:452-455`) is the only place that sets
`available` back to `true`, and it fires **per statement**:

```ts
} finally {
  deferredChunk = undefined;
  worker.available = true;
}
```

`releaseWorker` (`client.ts:554-578`) never touches the flag — it only hands the worker to
the next queued requester. So any owner holding a worker across several statements sees it
republished as free after the first one. `transaction()` is exactly such an owner: it
acquires once (`client.ts:917`) and then runs `readWorker` / `writeWorker` in a loop. A
concurrent `read()` can therefore be handed the same worker and execute **inside the open
transaction**.

Two owners write one flag. The fix is not to write it more carefully; it is to leave one
owner.

### Why abort is broken today

`signalAbortHandler` (`client.ts:424-431`) does one thing: set the `ABORTING` status byte
in the SharedArrayBuffer. Nothing on the client side ever reads `signal.aborted`. Three
consequences, all observed:

- **B9** — a signal that is *already* aborted when the query starts is ignored entirely.
  `addEventListener('abort')` never fires for it and nothing checks up front, so the query
  runs to completion and delivers every chunk.
- **FLK-1** — `INT-09` fails intermittently. The worker posts chunks as fast as it can
  produce them; for a 1000-row query at `chunkSize: 50` all 20 chunks are already in the
  message queue before the flag write lands, and the consumer drains a full buffer. The
  test asserts a *timing* property, so it passes or fails with the machine.
- **Listener leak** — `signal?.removeEventListener(...)` sits *after* the
  `while (deferredChunk)` loop (`client.ts:451`), so it is skipped on every early exit.
  `oneWorker` exits early **by construction** (`client.ts:713`), so every `one()` call
  leaves a listener attached to the caller's signal.

## 2. Non-goals

Explicitly not in this wave, and not to be "fixed while we are in there":

- **B2** (no `onerror` / `onmessageerror` / timeouts) and **B3** (`close()` settles
  nothing) — wave 2. Wave 1 introduces a wait that *depends* on wave 2 for robustness;
  see §6.4.
- **B5** (silent batch drops, `output()`'s non-atomic reload) — wave 3. `bulk.ts` is a
  pure move in this wave; its tests must pass unmodified.
- **B4** (identifier quoting), **B6** (debug wiring) — wave 3.
- **BP-1** (back-pressure) and **D2** (SAB removal) — wave 4. See §10.
- Scheduling *policy*. Lowest-index-first with a sticky writer is preserved exactly,
  including its known defect (reads pile onto worker 0, which is usually also the writer).
  The extraction makes the policy replaceable in one place; replacing it here would mix a
  performance change into a correctness change.
- No `CHANGELOG.md`. The library is at `1.0.0-rc.3` with **no consumer**, and none can
  appear before we choose to create one (standing assumption, user). The breaking changes
  are recorded in the memories, which is where they belong while there is no public.

## 3. Decisions

Settled at this wave's brainstorming, 2026-08-18, unless noted.

| # | Decision |
|---|---|
| 1 | **A caller abort rejects with the signal's reason** (`AbortError` by default) on `chunk()` / `stream()` / `read()` / `write()`. |
| 2 | **`first()` does not abort — it breaks.** The internal-AbortController design is dropped; see §6.3. |
| 3 | **Full W-arch split in this wave**, with `bulkWrite` and `output` together in `bulk.ts`. |
| 4 | **Exclusivity by opaque lease.** `PoolWorker.available` is deleted outright. |
| 5 | Inherited from D4 (`mem:resume-plan` §1.2): `chunk()` public, `stream()` yields rows, `one()` renamed `first()`, `signal` on every method, `chunkSize` on `chunk()` and `read()` only. |

### 3.1 Why a caller abort throws

The alternative — ending the generator silently, which is today's behaviour — leaves a
caller who aborts on a timeout unable to distinguish "I received everything" from "I was
cut off". They process a truncated result set as complete. That is a data-correctness
trap, not an ergonomics preference. `fetch` and the web streams both reject; we match the
platform.

`read()` and `write()` reject for the same reason: a partial array returned as if whole is
the same trap wearing a different shape.

## 4. Module layout

Flat, matching the existing `src/`. `worker/` stays the only subdirectory.

| Module | Role | Depends on |
|---|---|---|
| `scheduler.ts` | **Pure.** Queues, leases, writer designation. No `Worker`, no DOM, no orchestrator. Parameterised over `<W extends { index: number }>`. | nothing |
| `pool.ts` | Worker creation, transport: `postMessage` and `onmessage` routing by `callId`. Owns the `PoolWorker` type. | `orchestrator` |
| `queries.ts` | The `chunk()` primitive and its derivations. | `pool`, `scheduler` |
| `transaction.ts` | `transaction()`, over a single held lease. | `queries`, `scheduler` |
| `bulk.ts` | `bulkWrite()` + `output()`. | `queries` |
| `client.ts` | Assembly: options, validation, wiring, the public `SQLiteDB` surface, `close()`. | all |

`orchestrator.ts` and `worker/worker.ts` are **unchanged** by this wave.

This also settles the relocation question D3 §1.1 left open: `output()`'s target is
`bulk.ts`, not a module of its own.

## 5. The scheduler

```ts
type Lease<W> = { readonly worker: W; release(): void };

createScheduler<W extends { index: number }>(opts: {
  onIdle?: (worker: W) => void;
}): {
  add(worker: W): void;
  acquire(kind: 'read' | 'write'): Promise<Lease<W>>;
};
```

### 5.1 What the module owns exclusively

The set of available worker indices (a private `Set<number>`), both wait queues, and
`currentWriterIndex`. Nothing else in the codebase can read or write them.

**`PoolWorker.available` is deleted.** Not made read-only, not guarded — removed. B1's
`finally` becomes inexpressible rather than merely fixed: there is no field left to assign.
This is the whole point of the lease, and it is why option "add a `pinned` flag" was
rejected — it would have left two sources of truth and a door for the same bug to return
through.

### 5.2 The lease

`acquire()` resolves with a lease. `release()` is the only way back into the pool, and it
is **idempotent**: a second call is a no-op, not an error. Nested `finally` blocks will
overlap during the code movement, and a double release must be harmless rather than fatal.

A lease holder keeps its worker for the lease's entire lifetime, across any number of
statements. That is the B1 fix, stated positively.

### 5.3 Behaviour preserved exactly

- Write acquisition: if a writer is designated and free, take it; if designated and busy,
  queue on the writer queue; if none is designated, take any free worker and designate it.
- Release: writer queue first (only when this worker is the designated writer, or none is
  designated), then the reader queue (clearing the designation if this was the writer),
  otherwise back to the available set.

### 5.4 Why `onIdle` exists

`releaseWorker` currently ends with `orchestrator.setStatus(worker.index, READY)`
(`client.ts:576`). That is a SharedArrayBuffer concern, not a scheduling one, and importing
the orchestrator would destroy the module's purity — and with it the Node tests that are
this wave's main deliverable. The call moves out behind the `onIdle` hook, wired in
`client.ts`.

**Do not merge the two notions of state.** `available` is the *client-side* scheduling
view; the orchestrator's `READY` / `RUNNING` / `ABORTING` / `DONE` byte is the *worker-side*
view living in shared memory. They answer different questions and stay separate.

## 6. `queries.ts` — one primitive, one abort

### 6.1 The hierarchy

```
rawQuery()   AsyncGenerator<T[] | number>   private to the module, never exposed
  └─ chunk()   AsyncGenerator<T[]>          chunkSize lives HERE
      ├─ stream()  AsyncGenerator<T>        flattens
      ├─ read()    Promise<T[]>             drains
      ├─ first()   Promise<T | undefined>   first row, then breaks
      └─ write()   Promise<{result, affected}>  drains + captures the number
```

The `T[] | number` union stays internal. It is what forces every current call site to
write `typeof chunk !== 'number'`; only `write()` needs the affected count, and it reads
`rawQuery()` directly.

**Who holds the lease.** Each of the five public methods keeps today's six-line shape —
acquire, delegate, `finally release()` — and is the only lease owner. Each also has a
*worker-bound* variant taking an already-leased worker, which acquires and releases
nothing; those are what `transaction.ts` calls. A worker-bound variant that released a
lease it did not take is the bug this wave exists to eliminate, so the two forms stay
visibly distinct in name.

**Read/write routing does not change during the relayering.** `acquire('read' | 'write')`
is chosen by `isWriteQuery(sql)` at exactly the call sites that use it today. It is then
fixed **deliberately, in its own commit at the end of the wave** — see §6.5. The two must
not be mixed: a routing change buried in a code move is unattributable.

### 6.2 Abort, implemented once

Inside `chunk()`, in this order:

1. **Entry check** — `if (signal?.aborted) throw signal.reason` before any `postMessage`.
   Fixes **B9**.
2. **Listener removal in the `finally`**, never after the loop. Fixes the leak.
3. **Stop yielding immediately** once the signal fires. Whatever is already sitting in the
   message queue is *not* delivered. This is what makes **FLK-1** deterministic: the
   assertion no longer depends on whether the worker won the race.
4. **Await the in-flight `done` / `error`** before releasing the lease. Fixes the second
   half of **B1** — a worker freed while still inside `sqlite.step()`.
5. **Then throw `signal.reason`.**

### 6.3 `first()` breaks; it does not abort

D4 §1.2 documented a trap: `first()` aborts internally to stop after one row, so the
implementation had to distinguish the internal abort ("I got my row, resolve normally")
from the caller's ("cancelled, reject"), via `AbortSignal.any` plus a post-hoc test of
`caller.aborted`.

**The trap is removed rather than handled.** `first()` simply `break`s out of the loop. A
`break` triggers `gen.return()`, which runs `chunk()`'s `finally` — the same worker-stop
routine, reached by the normal path, with no exception. Two mechanisms, unambiguous:

- **caller's signal** → error;
- **early exit** (`break` / `return`) → normal completion.

`AbortSignal.any` is no longer used anywhere, so D4's open question about its browser
baseline is void.

### 6.4 What "the worker stops" does and does not promise

The worker tests the `ABORTING` byte on every row, before and after `sqlite.step()`
(`worker/worker.ts:182`, `:185`), so it does leave its loop early and does post `done`.

**The ack already exists — do not invent a protocol.** After breaking on `ABORTING` the
worker still posts `done` (`worker/worker.ts:227`). The client simply never waited for it.
Step 4 above waits.

But the *delay* is not bounded in rows. Between the worker posting the first chunk and the
main thread executing the `finally`, the worker keeps stepping. These are two real threads
and the shared-memory write is visible immediately, so the window is typically
sub-millisecond — but it is long enough to produce hundreds or thousands of rows. On a
1M-row query `first()` avoids the overwhelming majority of the work; on a small result set
it avoids none.

Two consequences:

- `one()`'s JSDoc (`client.ts:694`) claims it "aborts after receiving first result for
  efficiency". Reword to what is true: it *asks* the worker to stop.
- The hard bound arrives with **BP-1** (back-pressure, wave 4). With a per-chunk credit the
  worker cannot run ahead at all and `first()` costs exactly one row.

**Dependency to accept, not to solve here:** the wait in step 4 hangs forever if the worker
died. That is B2, wave 2. Do not pull wave 2 forward; note the dependency.

**Limitation to document:** a consumer who *abandons* a generator without `break` or
`return` never triggers the `finally`, so the worker stays held until the query ends. This
is inherent to JS generators.

### 6.5 `W-route`, first half: routing must not bypass exclusivity

`isWriteQuery()` (`utils.ts:24`) is a regex over raw SQL. It misses `VACUUM`, `ALTER`,
`ANALYZE`, `REINDEX`, `SAVEPOINT` and a manual `BEGIN`, so **those statements route to the
read pool**. A `VACUUM` can therefore run on an arbitrary worker while the designated
writer holds an open transaction.

This is not a separate defect from B1 — it is the same guarantee, breached one layer
higher. Wave 1 cannot honestly claim "exclusivity is real" while leaving a service
entrance open, so the fix belongs here, in **commit #6**, after the split is green.

**The fix inverts the default: allowlist reads instead of blocklisting writes.** A
statement routes to the writer unless it is provably a read (`SELECT`, `EXPLAIN`, `WITH …
SELECT`, `PRAGMA` reads). Extending the existing blocklist keyword by keyword would leave
the next unlisted statement — and every future SQLite keyword — silently misrouted. With
an allowlist, a misclassification fails toward the writer: correct, merely slower. The
regex's string-literal confusion is not fully solved by this (that needs tokenisation), but
its failure direction becomes safe.

**Not in this wave:** the second half of `W-route` — `write()` routing to the writer
unconditionally, and `read()` *rejecting* a write query instead of silently running it.
That is API strictness and error surface, which is wave 2's subject.

## 7. `transaction.ts` and `bulk.ts`

### 7.1 Transaction

Acquires **one lease, once**, and holds it to its `finally`. `TransactionDB`'s methods bind
to that lease's worker and call the worker-bound variants in `queries.ts` — never the
public methods, which would acquire leases of their own.

Four corrections fall out naturally:

- `commit()` and `rollback()` currently go through `oneWorker` (`client.ts:948-955`), i.e.
  `chunkSize: 1` followed by a `break` — the entire worker-stop machinery invoked for a
  `COMMIT` that returns no rows. Same for `db.read('BEGIN')`. Both move to an internal
  `exec(worker, sql)` that drains without abort machinery.
- `...args: any[]` on all four methods (`client.ts:929-946`) becomes real signatures. This
  is the part of `W-types` the wave can close without overreaching.
- `one` → `first`, and `chunk` added for symmetry with the public surface.
- The typo `'Cannot werite in read-only transaction'` (`client.ts:920`).

### 7.2 Bulk

`bulkWrite` and `output` **move without behaviour change**. They keep calling the public
methods — one lease per batch, worker released between batches — which is exactly what
D3 §1.1 requires be preserved for the wave 3 rebuild.

`bulk.ts` is the wave's control specimen: its diff must be a pure move modulo imports, and
`bulk-write.test.ts` / `output.test.ts` must pass **unmodified**. If either changes
behaviour, the wave has drifted.

`close()` stays in `client.ts`, untouched. B3 is wave 2.

## 8. Testing

### 8.1 New: `tests/unit/scheduler.test.ts` (Node, milliseconds)

The structural payoff of the wave.

- FIFO order within each queue; writer queue served before reader queue.
- Writer stickiness; designation cleared when the worker goes to a reader.
- **B1 at unit level**: a lease holder keeps its worker across N successive statements
  while other requesters are queued.
- `release()` idempotent.
- `onIdle` fires only when no queue is waiting.

### 8.2 Browser tests

- Both pinned `it.fails` turn red → drop `.fails` (B1 in `transaction.test.ts`, B9 in
  `concurrency.test.ts`).
- **`INT-09` rewritten**: abort now rejects, so `await expect(...).rejects.toThrow()`
  **plus an exact chunk count** (`toBe(1)`). A bound such as `< 20` on a now-deterministic
  mechanism would recreate the unfalsifiable-assertion defect wave 0 was spent removing.
- New: an instrumented signal asserts the `abort` listener is **removed** after `first()`.
- New: a worker is immediately reusable after `first()` — this is what waiting for `done`
  buys.
- New: surface checks — `stream()` yields rows, `chunk()` yields arrays.

### 8.3 Unchanged

`bulk-write.test.ts` and `output.test.ts` pass without modification. `queries.test.ts` and
`init.test.ts` change only where the renames touch them.

## 9. Sequencing

Full W-arch split plus semantic changes in one wave risks making a movement bug
indistinguishable from a logic bug. The mitigation is commit order, not scope reduction.

| # | Commit | Expected suite |
|---|---|---|
| 1 | Pure moves, one per module, no behaviour change | 105 green; both `it.fails` still failing |
| 2 | Scheduler: leases, `available` deleted | B1 red → `.fails` dropped |
| 3 | `queries.ts`: `chunk()` relayering + abort semantics | B9 red → `.fails` dropped; `INT-09` rewritten |
| 4 | Renames only: `first()`, `stream()`'s yield, `signal` everywhere | — |
| 5 | Transaction cleanups: signatures, `exec()`, typo, JSDoc | — |
| 6 | `W-route` first half: routing allowlist (§6.5) | new routing tests; existing tests may shift — isolated here so any shift is attributable |

`pnpm check`, `tsc --noEmit` and the full suite at every step. Feature branch, per the
phase workflow in `mem:resume-plan` §3.

## 10. Definition of done

The exit criteria already recorded in `mem:resume-plan` §2.2, restated:

1. Both `it.fails` removed because the bugs are fixed.
2. **FLK-1 gone for the right reason** — the abort check lives client-side in `chunk()`.
   Fixing B9 and the worker ack alone would leave the flake alive.
3. `INT-09` asserts an exact value.
4. The `done` ack is awaited before release.
5. **Exclusivity is not bypassable by routing** — `VACUUM`, `ALTER`, `ANALYZE`, `REINDEX`,
   `SAVEPOINT` and a manual `BEGIN` reach the writer (§6.5), with tests naming each.
6. Plus the standing three: CI green, memories updated, git clean.

## 11. Findings recorded for later waves

Discovered while reading the source for this design; none of them is wave 1 work.

- **D2's sequencing was wrong, now corrected** (`mem:resume-plan` §1.5). The worker's row
  loop is an unbroken chain of `await sqlite.step()` and never returns to its event loop,
  so a `postMessage` abort is never delivered mid-query. Shared memory is the only channel
  that reaches a worker in that state. The `ABORTING` flag therefore cannot leave the SAB
  until BP-1 exists — only the init mutex can move to `navigator.locks` in wave 3.
- **No VFS forces cross-origin isolation.** `grep -rE 'SharedArrayBuffer|Atomics\.'` over
  all of `node_modules/wa-sqlite` (`src/` and `dist/`) returns nothing. The COOP/COEP
  requirement is entirely ours, so D2 genuinely removes it.
- **BP-1 promoted and bound to wave 4**, ahead of the SAB removal it enables.
