# Measurements — interruption, abandoned generators, the write lock

Part of `mem:measurements`, which indexes every entry; its rules apply here. Moved here verbatim from `mem:measurements/transactions` on 2026-10-08.

## Query interruption — 2026-09-04/05, Chromium 151 / Firefox 153, this container

Full tables and their method are in the design,
`docs/superpowers/specs/2026-09-04-query-interruption-design.md` §4.3 — it is the only place
they are written out, and it was written from these runs. What follows is what a later
session needs without opening it.

**The mechanism, established before any code was written.** A non-zero return from
`sqlite3_progress_handler` ends a running `step()` with `SQLITE_INTERRUPT` on all three
builds and both engines, and the connection serves the next query immediately after. The
`sync` build REFUSES an async handler outright — "Synchronous WebAssembly cannot call async
function" — which is what splits the design in two.

**`SharedArrayBuffer` is ABSENT without cross-origin isolation, not merely restricted.**
Both engines: `crossOriginIsolated === false` ⇒ `typeof SharedArrayBuffer !== 'function'`.
So the `sync` build's caller-driven abort has a deployment condition, and it is the
consumer's to satisfy.

**`Document-Isolation-Policy: isolate-and-require-corp` alone**, no COOP, no COEP: page AND
dedicated worker both isolated on Chromium 151 — `SharedArrayBuffer` constructible, `Atomics`
working, `postMessage(SAB)` accepted. Firefox 153 ignores the header entirely. This is why
the library detects `cross-origin-isolated` and never a mechanism.

**GitHub Pages sends no `Cross-Origin-*` header and offers no way to add one** (measured on
the live site). The benchmark page is therefore permanently in the degraded row.

**Cost of the installed handler at N = 100 000**, five repetitions round-robin, two shapes
each calibrated to ~500 ms: the synchronous handler is free within noise at every N, and on a
query that RETURNS ROWS nothing is measurable at all — row marshalling dominates. The only
real cost is the async yield on pure computation: ~2-5 % at 10⁵, ~0-2 % at 10⁶. Abort
overshoot: 1-6 ms at 10⁵ on both engines; up to 87 ms at 10⁶ on Firefox/async, which is what
settled N.

**Durations the TESTS depend on** — if a test starts flaking, re-measure these first:
- `longQuery(10_000_000)`, async build, Chromium: **~2 082 ms** to completion; the test bound
  is 1 500 ms. Same query on Firefox: **~15 s**, which is why that test carries a 90 s
  timeout.
- `longQuery(20_000_000)`, sync build, MemoryVFS: **~4 343 ms** to completion; ~2 463 ms
  observed as the failure value under the feature-neutralising mutation, against a 500 ms
  bound.

## ABANDON-RESTART — what an abandoned generator costs a transaction, 2026-09-08, both engines

> **SUPERSEDED by `5df3c03` (2026-09-08), and the numbers below are kept because they are
> what made the fix necessary.** The restart this section prices no longer happens. The
> transaction now closes what the callback abandoned before it commits or rolls back —
> `closeOpenStatements()` in `src/transaction.ts` interrupts the transport, awaits the
> generator's `return()` and then `worker.quiesce()` — so the ROLLBACK meets an idle
> connection, trips no guard, and evicts nothing. Measured after the fix by
> `tests/browser/abandon-transaction.test.ts` → *commits, and evicts no worker*:
> `terminated=0 created=2`, and the transaction COMMITS rather than failing at all, so the
> `GENERATOR_ABANDONED` column below no longer has a value. The `AccessHandlePoolVFS`
> recovery figures (43 ms / 57 ms) now price a path an abandoned generator does not take.
>
> What survives: the restart is still what happens when a ROLLBACK genuinely fails for some
> other reason, and the stale-lease paragraph at the end is unaffected.
>
> Read on for the state before the fix.

Measured on `fix/abandoned-generator` during the final fix wave's re-review, with an
`interceptWorkers()` probe: abandon a `tx.chunk()` inside a `transaction()`, then count the
workers terminated and created. Default VFS, `poolSize: 2`, unless stated.

| | error code | workers terminated | workers created | later `SELECT 1` |
|---|---|---|---|---|
| before the fix (`94bfaac`) | `GENERATOR_ABANDONED` | **0** | 2 | ok |
| after the fix (`842f6dc`) | `GENERATOR_ABANDONED` | **1** | 3 | ok |

**The restart is new, and it is correct.** Before, the reuse guard's own `finally` stopped the
abandoned query, so the `ROLLBACK` that followed found a clean worker and succeeded — no
eviction. That `finally` had to become conditional, because it was resetting a LIVE query's
state when the transport was stale (`mem:lessons`, and the design's amendment A1). So the
`ROLLBACK` now trips the guard in turn, fails, and `onPoisoned` evicts the slot. The connection
genuinely holds an open transaction with a query in flight, which is the state eviction exists
for.

**Recovery measured on the worst case**, `AccessHandlePoolVFS` at `poolSize: 1` — the
configuration where the terminated worker's exclusive OPFS handle must be released before the
replacement can open: **Chromium 43 ms, Firefox 57 ms**, `terminated=1 created=2 ok=1` on both.
At `94bfaac` the same probe reads `terminated=0 created=1`.

**Two things this does not say.** The restart budget is finite, so a consumer abandoning
generators in a loop inside transactions will exhaust it where it previously would not —
unmeasured, and nothing in the suite exercises this path at `poolSize: 1`
(`abandon-transaction.test.ts` runs at 2, for an unrelated documented reason). And the stale
lease is harmless rather than merely untested: `scheduler.remove()` bumps a per-index
generation and a stale `release()` is a no-op, so the never-settling `quiesce()` cannot
republish the restarted worker.

The prose half of this used to live at the eviction site in `src/transaction.ts`. `5df3c03`
replaced that comment: the same `catch` now says that an abandoned generator no longer reaches
it, because `closeOpenStatements()` drained the generator before the ROLLBACK was attempted,
and that what remains there is a connection broken for some other reason. So the pointer is to
`closeOpenStatements()` and to that `catch` together — one explains why the eviction is gone,
the other what still reaches it.

## ABANDON-WEDGE — killing the handle's holder wedges the pool, 2026-09-09, both engines

**Method, because it is what made this measurable at all.** The defect appears about once in
eighteen runs of `pnpm test` and **never** on the Firefox config alone or on the one file alone
— the reproducing context was the full chain, at 80 s a run. Adding sixteen busy loops around a
single-file Firefox run reproduces it in 4-5 s instead, a twentyfold cut in time-to-failure, and
that is what turned a statistical argument into controlled cells. The defect is load-sensitive;
that is the handle to grab.

Scenario: an abandoned `chunk()` inside a `transaction()` on the pre-fix code, which evicts the
worker holding the rotated exclusive OPFS handle. Each cell is 40 runs under that load unless
stated.

| VFS | Chromium | Firefox |
|---|---|---|
| `OPFSCoopSyncVFS` — rotates always | 0/40 | **9/40 (22 %)** |
| `OPFSAdaptiveVFS` — rotates in degraded mode | 0 (suite always green) | 3 in ~36 chain runs; 1/8 and 1/50 loaded |
| `OPFSWriteAheadVFS` | — | **0/160** |
| `IDBBatchAtomicVFS` — no handle | — | 0/40 |

**Two controlled comparisons, one variable each.** Same VFS across engines: 0 against 9. Same
engine across VFS: 9 against 0. The factor is Firefox combined with a rotated exclusive handle,
and nothing else.

**A third, for the code:** the same validated probe, same VFS and engine, gives `main` 0/40
against the pre-fix branch 5/40 — the branch created the reachability, not the mechanism.
`handleDeath`, `terminate`, `spawn` and `onPoisoned` are byte-identical to `main`.

**What 0/160 buys and what it does not.** At Adaptive's ~3 %, 0/40 would still happen 30 % of
the time — which is why `OPFSWriteAheadVFS` was extended to 160, where the same null has a
probability of 0.7 %. **0/40 is not evidence of absence for a 3 % defect**, and the 40-run cells
above should be read with that in mind.

**A failed prediction, kept.** `OPFSWriteAheadVFS` was expected to be affected, inferred from
`mem:vfs`'s "degrades exactly like `OPFSAdaptiveVFS`". That sentence is about concurrency, not
handle ownership. The inference was wrong and only the measurement said so.

Behaviour and consequences: `mem:vfs`, HANDLE-2.

## WRITELOCK-STUCK — a stuck transaction callback blocks every write on the origin, 2026-09-09

> **PARTLY SUPERSEDED the same day, and the numbers are kept because they are what made the fix
> necessary.** The `close()` column no longer has those values: `close()` reclaims the write
> lock, and a statement issued after it rejects instead of hanging (`mem:history/waves`, § The origin
> write lock). **What still stands is the first half** — a callback that never returns holds the
> lock for as long as its tab lives, and that was refused deliberately rather than left undone.

**Deterministic, both engines, on the recommended VFS. This is not HANDLE-2 and has nothing to
do with OPFS handles**; it was found while trying to reproduce HANDLE-2 and reproduces where
HANDLE-2 does not.

A `transaction()` whose callback awaits something that never settles — user code, a fetch, a
prompt — holds `bsq:write:<ns>:<file>` for the origin. Every write in every tab then blocks
**for ever**, silently; reads are unaffected. Firefox/`OPFSCoopSyncVFS`, 8 iterations per form
under sixteen busy loops:

| form | transaction | `bsq:write` | other client's write | `close()` | lock after `close()` |
|---|---|---|---|---|---|
| crash while a statement is IN FLIGHT | `WORKER_CRASHED` | released | ok | ok | released |
| crash BETWEEN two statements | `WORKER_CRASHED` | released | ok | ok | released |
| control, no crash, normal callback | ok | released | ok | ok | released |
| **stuck callback + worker crash** | **never settles** | **held** | **blocked** | **`ok`** | **held** |
| **stuck callback, no crash** | **never settles** | **held** | **blocked** | **> 8 s budget** | **held** |
| stuck callback + `timeout: 3000` | `OPERATION_TIMEOUT` | released | ok | ok | released |

**The crash is not the cause — it is what makes `close()` LIE.** With the worker alive `close()`
outlasts the 8 s budget, which at least shows; it is bounded by `drainTimeout` in code
(`client.ts`, whose comment anticipates exactly a callback that never returns), so it does
settle — the completion was not measured. With the worker dead it returns `ok` in under a
second. **Either way it never releases the write lock**, which is the defect: the consumer's
only escape reports success and changes nothing.

**Confirmed engine- and VFS-independent**, on `OPFSAdaptiveVFS` (recommended), chained on both
configs — Chromium and Firefox produce identical lines. And permanent: the lock is still held at
10 s, 40 s and 70 s, past the 60 s default `drainTimeout`, and a write issued then still hangs.

**`timeout` (and `signal`) is a complete mitigation**, exactly as `API.md` documents. What
`API.md` does NOT say is that the hold is unbounded — its warning reads "for as long as its
callback runs", which a consumer takes as "as long as my slow thing takes" — nor that `close()`
does not reclaim it.

**Closing the offending TAB does fix the origin** — measured the same day with a same-origin
iframe standing in for a tab, since a test page cannot open one: the iframe takes a lock, is
removed from the document, and the lock reads `before=true after=false`, with a second holder
acquiring it immediately (`reacquired=true`). So the blockage is bounded by the life of the tab
that caused it, not by the life of the origin. It is the tab that stays open and stuck that has
no way out.

Method: `interceptWorkers()` for the worker handle, an `ErrorEvent` dispatched on it for the
crash (`spawned`/`terminated` counted to prove the crash landed), `navigator.locks.query()` for
the lock.

**A probe mistake worth not repeating.** The transaction promise was `.catch()`-ed before being
handed to the timing helper, so every rejection came back as `ok` and a whole run read
`tx:ok` — the opposite of what happened. Let the helper own the catch.

## GEN-ABORT — every statement abortable: cost, benefit, concurrency, 2026-10-02, this container

**Method.** A throwaway worktree of `main` (`223d472`) where a page flag forced `abortable` on in
`chunk()` and `writeWorker`, so the "on" arm was exactly the change `feat/always-abortable` then
made, with no signal and no abort race, and "off" was `main`. rstest probe files, one run per
(engine, pair): every declared pair on Chromium 151 and Firefox, plus the four `sync` pairs on
Chromium cross-origin isolated — 48 cells for reads, 48 for writes. Arms alternated, results posted
to a local collector. Workloads calibrated per cell to ~400 ms (Firefox recursion is 4-5× slower).

**Benefit** — the next `SELECT 1` on a `poolSize: 1` client after leaving a ~1 s step (median of 4):

| exit | off | on |
|---|---|---|
| `first()` on row 1 of 2, `chunk()` `break`, `stream()` `break` — `async`/`jspi`, every VFS, Chromium | ~1 000 ms | 1-2 ms |
| same, Firefox | ~1 000 ms | 4-10 ms |
| same, `sync` isolated (the slot poll) | ~1 000 ms | 1 ms |
| same, `sync` without isolation | ~1 000 ms | ~1 000 ms |
| `chunk()` `break` on short rows, default `chunkSize` | 0-6 ms | 0-6 ms |

**Read cost** (7 alternated rounds): compute without rows, cached self-join, `stream()` and `read()`
of 100 000 rows — every ratio 0.93-1.04, sign varying. The 2-5 % on pure computation recorded in
September did not reproduce (0.97-1.02). **Per statement** (2 000-statement batches, 15 rounds):
-10 to +13 µs; re-runs of the one cell that leaned one way (`OPFSWriteAheadVFS/jspi`, Chromium)
gave 0 to +4 µs — at most a few µs, ≤ 2 % of a statement that does nothing.

**Write cost** (insert in one statement, CPU-bound write, `UPDATE` of 100 000 rows, 100 single
`write()`, `bulkWrite` of 150 000 rows): median paired ratio 1.002 over 233 workloads; 13 outside
±5 %, in both directions, including `MemoryVFS/sync` without isolation where the change does
nothing (0.92). Two artefacts to know before reading such a table again: `AccessHandlePoolVFS`
alternates slow/fast run by run (~760/~430 ms on an insert into a freshly recreated table, the same
on `sync` where the arms are identical by construction), and `IDBBatchAtomicVFS` drifts upward
across runs. An A/A control (both arms off, 15 rounds) spread 0.87-1.03 on `IDBBatchAtomicVFS`,
which is what its 1.12-1.14 in the matrix was.

**Concurrency.** A ~2 s read, then a ~2 s write, on one worker, while the client's other worker
(where the pool has two) and a second client ran 10-12 reads and writes: 464 write rounds and every
read round, both arms — no error, no partial state seen (a count of the table being written was
always 0 or the total), row counts, snapshot sums, final sums and `integrity_check` all correct.
**`OPFSAdaptiveVFS` (Firefox) and `OPFSCoopSyncVFS` do not hand their handle over mid-statement**:
the second client waits the statement out in both arms. Latencies equal between arms.

**Not measured.** Safari: Playwright's WebKit here needs root-installed system libraries (gstreamer,
gtk4…). A second tab: equivalent at the VFS level to a second client, which was measured.
