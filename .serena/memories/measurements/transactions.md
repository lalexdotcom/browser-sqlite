# Measurements — transactions, aborts, the write lock

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## TX-M1M2 — a write stopped after its first row, and the savepoint premise, 2026-09-11, all three configurations

**Method.** A throwaway probe, copied into
`tests/browser/` (chromium project, firefox config) and `tests/browser/isolated/` (isolated
project) for the run and deleted; logs `m1m2-*.log` beside it. `main` after `9479f4a`. Three
runs per configuration: `OPFSAdaptiveVFS` `async` and `MemoryVFS` `sync` not isolated on both
engines, `MemoryVFS` `sync` isolated on Chromium. 50 000-row write from a recursive CTE.
**All 45 results identical to their arm across runs, engines and builds.**

- **M1 — a write stopped after its first row does NOT take the transaction with it.** Inside
  one transaction: `INSERT (1)`; `tx.first()` on `WITH … INSERT INTO s SELECT … RETURNING n`
  (and, second arm, a `break` out of `tx.chunk()` on it after 10 rows); `INSERT (2)`. Resolved;
  `t=[1,2]`; all 50 000 rows of `s` kept; no worker replaced. Consistent with SQLite running the
  whole DML of a `RETURNING` statement in the first `step()`. Asked by the savepoint spec §7
  before any code; no defect.
- **M2 — a savepoint undoes a write run to its end, and only it.** `INSERT (1)`; `SAVEPOINT sp`;
  the 50 000-row insert; `ROLLBACK TO sp`; `RELEASE sp`; commit: `t=[1]`, `s=0`, every
  configuration. The premise of the savepoint spec.

## TX-SAVEPOINT — what approach A's savepoint round trips cost a write, 2026-09-11, this container, both engines

**Method.** A throwaway probe, copied into
`tests/browser/` for the run and deleted; the six logs sit beside it. `main` after `9479f4a`,
chromium project and firefox config, **three runs each**. Every arm is ONE `db.transaction()`
of K=20 writes, so BEGIN/COMMIT and the lease are constant; arms interleaved inside each of 15
iterations after 2 warm-ups; per-write cost = (median(arm) − median(base)) / 20. The savepoint
statements go through `tx.write()`, so the figures are an **upper bound** for the internal
`exec()` approach A would use. Default build per VFS. **Firefox's `performance.now()` is
1 ms-grained here** (not isolated), so its per-write figures move in steps of 0.05 ms.

Median of the three runs, ms per write:

| Engine | VFS (build) | bare write | + SAVEPOINT, RELEASE | + SAVEPOINT, ROLLBACK TO, RELEASE | + two `SELECT 1` (control) |
|---|---|---|---|---|---|
| Chromium | `OPFSAdaptiveVFS` (async) | 0.415 | 0.065 | 0.185 | 0.140 |
| Chromium | `OPFSWriteAheadVFS` (sync) | 0.215 | 0.115 | 0.165 | 0.165 |
| Chromium | `MemoryVFS` (sync) | 0.090 | 0.075 | 0.160 | 0.160 |
| Firefox | `OPFSAdaptiveVFS` (async) | 0.400 | 0.300 | 0.500 | 0.500 |
| Firefox | `OPFSWriteAheadVFS` (sync) | 0.200 | 0.300 | 0.500 | 0.450 |
| Firefox | `MemoryVFS` (sync) | 0.200 | 0.300 | 0.450 | 0.450 |

Spread of the nominal path across runs: 0.060-0.140 Chromium, 0.200-0.350 Firefox.

**Reading.** The savepoint pair costs no more than two bare round trips: the price is the
round trips, not SQLite's savepoint. It is paid only by a write carrying its own
`signal`/`timeout`.

**A against a proxy of B, same day, same machine.** Probe `probe-b.test.ts` beside the first,
logs `b-*.log`; **K=200** writes per transaction so the gap is visible and Firefox's 1 ms clock
negligible; 15 iterations after 2 warm-ups, three runs per engine, median of the three. Every
arm uses one constant INSERT with inline values. B is approximated by one multi-statement
string (`"SAVEPOINT bsq; INSERT …; RELEASE bsq"`, one round trip); **worker.ts marks such a
string `uncacheable` and re-prepares it on every call**, which a real B would not do — so the
proxy OVERSTATES B's cost, and the A−B gap is a floor on what B saves. Abandoned path: A is
four round trips, the B proxy two (`"SAVEPOINT; INSERT"` then `"ROLLBACK TO; RELEASE"`).

Added ms per write over a bare write (bare write = its per-transaction median / 200):

| Engine | VFS | bare | A nominal | B nominal | A−B | B saves | A abandoned | B abandoned | A−B |
|---|---|---|---|---|---|---|---|---|---|
| Chromium | `OPFSAdaptiveVFS` async | 0.102 | 0.128 | 0.020 | 0.108 | 84% | 0.193 | 0.078 | 0.115 |
| Chromium | `OPFSWriteAheadVFS` sync | 0.084 | 0.130 | 0.013 | 0.117 | 90% | 0.180 | 0.085 | 0.095 |
| Chromium | `MemoryVFS` sync | 0.068 | 0.123 | 0.010 | 0.113 | 92% | 0.190 | 0.081 | 0.110 |
| Firefox | `OPFSAdaptiveVFS` async | 0.135 | 0.260 | 0.115 | 0.145 | 56% | 0.420 | 0.290 | 0.130 |
| Firefox | `OPFSWriteAheadVFS` sync | 0.120 | 0.245 | 0.095 | 0.150 | 61% | 0.395 | 0.265 | 0.130 |
| Firefox | `MemoryVFS` sync | 0.105 | 0.240 | 0.095 | 0.145 | 60% | 0.385 | 0.275 | 0.110 |

Whole transaction of 200 opted-in writes, nominal path, A → B proxy: Chromium 45.9 → 24.3 ms
(Adaptive), 42.7 → 19.3 (WriteAhead), 38.2 → 15.7 (Memory); Firefox 79 → 50, 73 → 43,
69 → 40. The "bare" column here is lower than the first table's because K=200 amortizes
BEGIN/COMMIT over ten times more writes.

**Observed, not investigated:** every Firefox run logged `worker 1 lost; pool is now 1 of 2`,
from client `SQLite 2` — the file's second client, which is the `OPFSWriteAheadVFS` arm if
clients number in test order; the console block is repeated under each failing test, so the
attribution is not confirmed. Never on Chromium. It cannot move these figures, since a
transaction runs on one worker. The closure baseline cannot say whether the normal Firefox
suite does the same: the closure baseline's log captured no console output.

**M3 — the real B's cost, 2026-09-11, this container, both engines.** Method: a throwaway probe,
copied to `tests/browser/zz-m3.test.ts` for
the run and deleted; six logs `m3-*.log` beside the others. Two arms only, same K=200, 15
iterations after 2 warm-ups, three runs per engine as probe-b: `base` (`tx.write(INS)`) and
`real` (`tx.write(INS, [], { timeout: 60_000 })` — a real timeout, so every write carries a
signal the worker must guard against and takes the actual approach B path, opening
`__bsq_sp` inside the write's own message; the 60 s timeout never fires). Per-write cost =
(median(real) − median(base)) / 200, median of the three runs — no proxy, no multi-statement
string, the production code path measured directly.

| Engine | VFS (build) | real B, ms/write | proxy B nominal (same VFS, above) |
|---|---|---|---|
| Chromium | `OPFSAdaptiveVFS` (async) | 0.0185 | 0.020 |
| Chromium | `OPFSWriteAheadVFS` (sync) | 0.0155 | 0.013 |
| Chromium | `MemoryVFS` (sync) | 0.0160 | 0.010 |
| Firefox | `OPFSAdaptiveVFS` (async) | 0.085 | 0.115 |
| Firefox | `OPFSWriteAheadVFS` (sync) | 0.085 | 0.095 |
| Firefox | `MemoryVFS` (sync) | 0.085 | 0.095 |

**Reading.** On Firefox the real cost sits below the whole proxy range (0.085 vs
0.095-0.115), consistent with the proxy's own caveat above — the uncacheable multi-statement
string overstates B's cost there. On Chromium the picture is mixed, not uniformly lower:
`OPFSAdaptiveVFS` comes in under the proxy (0.0185 vs 0.020) but `OPFSWriteAheadVFS` and
`MemoryVFS` come in slightly OVER it (0.0155 vs 0.013, 0.0160 vs 0.010) — a few thousandths
of a ms, inside the noise this probe already showed (spread 0.060-0.140 on the nominal path
in the first table), but reported as measured rather than smoothed over. M3 is the number to
cite for what approach B actually costs a write; the proxy above stays for how the earlier,
faster estimate was derived and why it was expected to be an overstatement.

## TX-AUTOCOMMIT — an interrupted write inside a transaction, 2026-09-10, this container, both engines

**Method.** Throwaway probes, one (chromium and
firefox projects) and `memory-isolated.test.ts` (the isolated project), run on
`fix/tx-statement-timeout` BEFORE its fix — the code of `main` at the time. `poolSize: 1`,
`debug: true`, a worker's replacement detected by a changed `creationTime`. Inside one
`db.transaction()`: `INSERT (1)`; an `INSERT … SELECT` of 1 000 000 rows from a recursive CTE
carrying its own `signal`, aborted after 30 ms; `INSERT (2)`. Three runs per case, **every
case identical across runs and engines** — deterministic.

| Build (VFS) | Callback | Observed | Evicted |
|---|---|---|---|
| `async` (`OPFSAdaptiveVFS`, `OPFSWriteAheadVFS`, `MemoryVFS`); `sync` isolated (`MemoryVFS`) | catches | the write rejects in 31-44 ms; `INSERT (1)` is gone INSIDE the callback (SQLite rolled back); `INSERT (2)` lands in autocommit; `COMMIT` fails *cannot commit - no transaction is active*; row 2 durable | yes, every run |
| same | does not catch | rejects with the reason; data correct; the fallback `ROLLBACK` fails the same way | yes, every run |
| `sync` not isolated (`OPFSWriteAheadVFS`, `MemoryVFS`) | catches | the write runs to its end (1.5-1.6 s Chromium, 2.2-2.3 s Firefox on OPFSWriteAheadVFS) and its 1 000 000 rows COMMIT although the caller got a rejection | no |
| same | does not catch | clean rollback | no |

**On a memory VFS the eviction wipes the database**: the next read failed with `no such
table: t` for a table committed before the transaction — the respawned worker opens an empty
memory database. Natural duration of the insert outside any transaction, for scale:
356-430 ms Chromium, 1.8-2.5 s Firefox (`MemoryVFS`).

**Status:** fixed by merge `eeabe06`; pinned by `tests/browser/tx-abort.test.ts`. Design:
`docs/superpowers/specs/2026-09-10-transaction-abort-design.md` §1.1.

## TX-HANDLE — a `tx` handle used after its transaction ended, 2026-09-10, both engines

**Method.** Two throwaway probes (a rollback and an after-end one), default `OPFSAdaptiveVFS`/`async`, `poolSize: 1` so the next transaction
lands on the same worker; transaction A ends, B writes `b1` and pauses between two
statements, A's handle is used, B writes `b2` and commits. Three runs per arm, plus a control
arm with no late call; identical across runs and engines.

| How A ended | Late call on A's `tx` | B | Evicted |
|---|---|---|---|
| abandoned by its signal | `rollback()` resolves | destroyed: rows `['b2']`, B's COMMIT fails | yes |
| committed | `rollback()` resolves | destroyed the same way (`['a1','b2']`) | yes |
| committed | `write('late')` resolves | contaminated: `late` commits with B | no |
| control | — | commits `b1`, `b2` | no |

**Present in `1.0.0-rc.4`** — `rollback()` there is the same unguarded `exec(worker,
'ROLLBACK')`, read from the tag. Found because the user asked to verify a claim the design
had marked "read from the code, not measured". **Status:** fixed by merge `eeabe06`; pinned by
`tests/browser/tx-handle.test.ts`.

## TX-M1 — an interrupted READ, and `SQLITE_FULL`, inside a transaction, 2026-09-10, both engines

**Method.** A throwaway probe, three runs per case.
**Read:** `longQuery(20_000_000)` (seconds to complete) cut by its own signal at 30 ms, after
warming a different statement; `OPFSAdaptiveVFS` and `MemoryVFS`, `async`. The read rejected
in 32-39 ms and the transaction **survived**: it committed `[1, 2]`, no eviction. This is the
premise of R7 — an interrupted read-only statement does not roll the transaction back.
**`SQLITE_FULL`:** `PRAGMA max_page_count = page_count + 3`, then an INSERT of 20 000 rows
of 500 characters, caught; `OPFSAdaptiveVFS` `async` and `MemoryVFS` `sync`. SQLite undid
the statement alone and the transaction committed `[1, 2]` — so the "connection left the
transaction" trigger cannot be provoked this way in a browser, and its test is unit-only.
**Noted in passing:** that error reached the client with neither `code` nor `sqliteCode`
(`mem:follow-ups`).

**One number NOT measured by the controller:** the Task 5 implementer reported that under the
full suite, lease acquisition plus `BEGIN` took 150-170 ms — enough to spend a 100 ms
transaction `timeout` before the callback ran. Not re-measured; it is why that test's budget
is 1 000 ms, and it is a story until someone times it.

## TX-QUIESCE — what the per-statement wait costs, 2026-09-10, this container, Chromium

**Method.** A throwaway probe, run as a browser test on the
`chromium` project (NOT cross-origin isolated). Every arm runs the SAME shape — one
`db.transaction()` per iteration — so BEGIN/COMMIT, the lease and the client are constant
across arms and the difference between them IS the wait `settled` adds. Two warm-up
iterations discarded per arm; medians below, n=15 except where stated. Table `t` holds 2000
rows. Branch `fix/tx-statement-quiesce`.

| arm | VFS / build | n | median | p90 |
|---|---|---|---|---|
| `tx.first()`, single-row result | OPFSAdaptiveVFS / async | 15 | **2.1 ms** | 2.8 |
| `tx.first()`, 2000-row result (worker parked holding row 2) | OPFSAdaptiveVFS / async | 15 | **1.7 ms** | 2.1 |
| `tx.read()`, 2000 rows | OPFSAdaptiveVFS / async | 15 | 3.7 ms | 4.5 |
| `tx.write()`, one row | OPFSAdaptiveVFS / async | 15 | 2.5 ms | 3.4 |
| `tx.first()`, cheap row 1 then a 3 M-row recursion for row 2 | OPFSAdaptiveVFS / async | 5 | **2.4 ms** | 2.x |
| `db.first()`, same query — CLIENT path, no signal | OPFSAdaptiveVFS / async | 5 | **683.6 ms** | — |
| `tx.first()`, 2000-row result | OPFSCoopSyncVFS / **sync** | 15 | **0.8 ms** | 1.1 |
| `tx.first()`, cheap row 1 then the recursion | OPFSCoopSyncVFS / **sync** | 5 | **360.5 ms** | — |

**Three things this establishes, and one it destroyed.**

1. **The wait is free on the ordinary path, and the "many rows" arm is not slower than the
   "single row" one** — 1.7 ms against 2.1 ms, i.e. inside the noise. The claim that
   `quiesce()` costs nothing where nothing is pending is measured, not reasoned.

2. **It destroyed the premise that a transaction's statements are not abortable.**
   `src/transaction.ts` carried a comment saying a transaction with no `signal` and no
   `timeout` passes `abortable: false`; `API.md` carried a `[!WARNING]` resting on the same
   premise. Both were false, and both predate this branch. `withSignal` merges the
   transaction's signal into every statement, `mergeSignals(a, b)` returns the surviving side
   when one is absent, and `closeSignal` is ALWAYS defined — so a statement inside a
   transaction always carries a signal and worker.ts always installs its progress handler.
   The 2.4 ms against 683.6 ms on the same query is the proof: the transaction cuts the
   expensive step. Had it not, `settled` would have waited for the recursion and the arm
   would read ~683 ms like the control.

   **Where the client path's 683.6 ms actually lands, because the number is misleading
   otherwise:** not inside `db.first()`, which returns as soon as row 1 arrives. The lease
   goes back through `void quiesce().then(release)`, so the drain is paid by the NEXT call's
   `acquire()` — with `poolSize: 2` the first two iterations are fast and the rest wait on a
   worker still finishing the previous recursion. It is a clean illustration of the argument
   that refused option B: a wait attached to the wrong statement shows up on the innocent
   one.

3. **What decides the cost is the BUILD, not the options.** On the `sync` build without
   cross-origin isolation worker.ts installs no progress handler at all (no yield to read the
   stop, no abort slot to poll), so the wait is the rest of the running `step()`: 360.5 ms on
   the pathological query, and `drainTimeout` in the worst case. That, and only that, is what
   the `API.md` warning now says.

**The pathological query, so it can be re-run:** `SELECT 1 AS n UNION ALL SELECT (WITH
RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) SELECT count(*)
FROM c)` — row 1 is immediate, row 2 costs the whole recursion inside one `step()`, which is
exactly the shape `first()` leaves behind with `chunkSize: 1` / `credits: 1`.

**Not measured:** Firefox, and any engine off this container. The sync/async split is the
axis that matters here and it is covered on Chromium only.

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
> lock, and a statement issued after it rejects instead of hanging (`mem:state`, § the origin
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

## TX-CONTROL-GUARD — refusing transaction control: the authorizer against a check on each statement's head — 2026-10-03, this container, Chromium 151.0.7922.34 / Firefox 153 (Playwright `firefox-1538`)

For the `tx.savepoint()` brainstorm: the library would refuse `BEGIN`/`COMMIT`/`END`/`ROLLBACK`/`SAVEPOINT`/`RELEASE` from the consumer, outside `transaction()` and inside it. Two mechanisms compared, both letting SQLite split the string rather than a regex over it.

**Method.** wa-sqlite at the pin (`7fcc30df`), loaded directly in a module worker, `MemoryVFS` so no I/O enters; one worker per arm, because `Module.set_authorizer` keeps ONE authorizer per module (`pAsyncFlags` is module-scoped in the glue). Arms: `none`; `wrapped` — `sqlite3.set_authorizer`, a sync callback denying actions 22 (`SQLITE_TRANSACTION`) and 32 (`SQLITE_SAVEPOINT`); `raw` — `Module.set_authorizer` with raw pointers, strings decoded only for 22/32; `head` — after each prepare, `sqlite.sql(stmt)` tested against `^(?:\s+|--…|/*…*/)*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i`. Workloads per batch of 1000: `wide` = prepare + finalize of a distinct 50-column `SELECT` (52 authorizer calls each); `insert` = a distinct one-row `INSERT` prepared and run (1 call); `cached` = one statement stepped and reset (no prepare). Arms interleaved in random order, 9 rounds after a warm-up, median; 3 pages per (engine, build). µs per statement, median of the 3 pages; ranges were within ±3 %. Probe: `.scratchpad/authorizer-cost-2026-10-03/`.

| engine/build | wide: none / wrapped / raw / head | insert: none / wrapped / head |
|---|---|---|
| Chromium sync | 14.3 / 19.9 / 17.0 / 14.9 | 25.6 / 24.7 / 24.8 |
| Chromium async | 19.8 / 25.5 / 22.6 / 20.5 | 27.7 / 26.9 / 27.8 |
| Chromium jspi | 14.8 / 24.9 / 21.7 / 16.0 | 28.7 / 29.1 / 30.0 |
| Firefox sync | 112.7 / 132.9 / 126.8 / 113.1 | 82.0 / 81.4 / 81.6 |
| Firefox async | 137.6 / 157.6 / 154.8 / 140.6 | 89.8 / 90.3 / 89.2 |
| **Firefox jspi** | **124.0 / 770.9 / 768.9 / 125.3** | 380.8 / 393.0 / 383.0 |

- **The authorizer costs one wasm→JS crossing per action of every prepare**: 0.1-0.2 µs per call on Chromium, 0.3-0.4 µs on Firefox sync/async, **≈ 12.4 µs on Firefox jspi** — 6.2× the whole prepare of a 50-column `SELECT`, and the default build on Firefox for `OPFSAdaptiveVFS`. Decoding the strings is not the cost: `raw` saves little, and nothing on Firefox jspi. Why: the jspi build wraps every relay import (`ipppppip`, `…_async`, `invoke_.*`) in `WebAssembly.Suspending`, sync or not, and **Firefox charges a `Suspending` import almost a real suspension even when the JS function returns at once**. Hand-written wasm module, a loop calling one empty import, in a dedicated worker, median of 7, 3 pages per engine, same day: plain import 0.004 µs per call on both engines; `Suspending` import, sync function: **2.2-2.4 µs on Firefox** against 0.055-0.06 µs on Chromium; `Suspending` import, async function (a real suspension): 2.7-3.0 µs on Firefox, 0.055 µs on Chromium. That accounts for a fifth of the 12.4 µs per authorizer call; the rest (wa-sqlite's relay, or a crossing that costs more from inside a prepare than from a shallow loop) is not explained. The same tax falls on every synchronous VFS call of the jspi build on Firefox; cause, fix and its measurement on `OPFSAdaptiveVFS`: JSPI-SYNC-RELAYS (`mem:measurements/statement-cache-and-perf`).
- **The head check costs 0.4-1.2 µs per prepared statement, on every build**, inside the noise for a one-row `INSERT`. Neither costs anything on a cache hit, as expected (`cached` flat).
- **Both refuse `BEGIN` on every build** (`SQLITE_AUTH`, 23, for the authorizer).

**What SQLite's split gives the head check** (Chromium, sync; the parser is the same on every build): `sqlite3_sql` returns each statement as SQLite isolated it, leading comments and whitespace included, a compound's `;` kept on the first — `"INSERT …; SAVEPOINT y"` → `"INSERT …;"` and `" SAVEPOINT y"`. `CASE … END`, `INSERT OR ROLLBACK`, `CREATE TRIGGER … BEGIN …; END` and `SELECT ';BEGIN'` stay one statement with a non-control head, and the authorizer sees no control action in them either. `EXPLAIN BEGIN` differs: the authorizer reports `TX:BEGIN` for it, the head check sees `EXPLAIN` — it runs nothing, either answer is harmless. The authorizer reports `END` as `COMMIT` and `ROLLBACK TO x` as a savepoint `ROLLBACK`.
