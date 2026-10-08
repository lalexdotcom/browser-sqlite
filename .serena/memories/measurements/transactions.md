# Measurements — transactions

Part of `mem:measurements`, which indexes every entry; its rules apply here. Interruption, abandoned generators and the write lock moved to `mem:measurements/aborts` on 2026-10-08.

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

## SAVEPOINT-STACK — open savepoints cost quadratically — 2026-10-03, this container, Node 24.13.0 `node:sqlite` (SQLite 3.50.4, native)

For the `tx.savepoint()` design: whether `release()` is worth exposing. One transaction (`BEGIN IMMEDIATE`) on a file database, default journal; per iteration `SAVEPOINT s<i>`, one `INSERT` of a 200-byte `randomblob`, then `RELEASE s<i>` in one arm and nothing in the other; `COMMIT`. Median of 3 per cell.

| savepoints | released as they go | left open until `COMMIT` |
|---|---|---|
| 1 000 | 1.4 ms | 5.5 ms |
| 4 000 | 4.6 ms | 32.3 ms |
| 16 000 | 20.6 ms | 282.8 ms |

Linear released, quadratic open: every page write walks the open savepoints (`pager.c`, from memory, not re-read). Native, not WASM; not measured in a browser, where it can only be slower in absolute terms.
