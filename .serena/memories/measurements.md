# Measurements — every number, with its date and method

**Rules for this file.** A number enters only with a date, a method and the machine it was
taken on. Correct an entry in place when it is re-measured; do not append a contradicting
one. A number nobody can reproduce is a story, not a measurement — say so in the entry.

## IDB-SIGNAL — a signal lets `IDBBatchAtomicVFS` serve a read during a long query, 2026-09-14, this container

**The discrepancy.** The bench's `reads-during-long-query` reported `IDBBatchAtomicVFS/async`
`false` in every export from 2026-09-04 to 2026-09-08 — previews `2700426`, `45e67fa`, `0b63bf3`;
Chromium 150, Firefox 154, Safari macOS/iPadOS/iOS, Chrome Android — and `true` in every export at
`main@29fbc71`: Firefox 153 ×3 and Chromium 151 ×1, this container, `poolSize` 4. Not the
calibration (Chromium: 971 iterations against 953-979 on 2026-09-04), not the row (its body is
unchanged since 2026-09-04).

**The probe** — `.scratchpad/idb-long-2026-09-14/probe2.test.ts`, current `main`, pool 4, 4 000
rows, a self-join as the long query, a point read 50 ms in, 3 runs per arm, one variable: a
`signal` on the queries.

| | Chromium 151 | Firefox 153 |
|---|---|---|
| IDBBatchAtomic, no signal | **waited** — read 109 ms behind a 187 ms query | **waited** — 796 behind 836 |
| IDBBatchAtomic, signal | served — 2 ms | served — 3-4 ms |
| OPFSAnyContext, either (control) | served — 2-3 ms | served — 3 ms |

Deterministic, 3/3 per arm on both engines.

**The mechanism.** `IDBBatchAtomicVFS.jLock` opens a `'rw'` IndexedDB transaction on reaching
SHARED (it clears a failed batch's blocks), and its `'ro'` reads reuse it while it is pending. An
IDB transaction commits only when its thread gets back to the event loop with nothing pending, so a
connection busy in one statement keeps it, and every other connection's SHARED lock queues behind
it until the statement ends — with the bench's dataset reaching storage as much as with the
probe's cached one. Since `f4b3fd7` (2026-09-04 20:35 — after the HANDLE-1 exports, and not in
`0b63bf3`) a query given a `signal`, or a `timeout` (`withDeadline` turns it into one), runs with
`abortable: true`, and on the `async` and `jspi` builds the worker installs a progress handler
that awaits `gate.tick()` every `PROGRESS_OPS` (100 000) VM ops: a task turn, so the transaction
commits. The bench row has passed its row `signal` to the long query since it was written — it
measured the unsignalled path until `f4b3fd7` and the signalled one since.

**What it changes.** HANDLE-1's "IDBBatchAtomic waited" holds for a statement with neither `signal`
nor `timeout`, and is false for one with either. `IDBMirrorVFS` is not concerned: its SHARED lock
opens no IndexedDB transaction, and it runs one worker.

**The yield costs nothing measurable.** Probe `.scratchpad/idb-yield-cost-2026-09-14/probe.test.ts`,
same day, `IDBBatchAtomicVFS` at `poolSize` 1, `async` and `jspi` builds, each workload with and
without a never-aborted `signal`, order alternated, 1 warm-up + 5 measured, medians. Ratio
signal / none:

| workload | Firefox async | Firefox jspi | Chromium async | Chromium jspi |
|---|---|---|---|---|
| CPU self-join, 3 000 rows cached | 0.99 | 1.03 | 1.03 | 1.04 |
| scan of 100 000 rows, beyond the page cache | 1.02 | 1.02 | 1.02 | 1.00 |
| 50 000-row insert, one statement | 1.01 | 0.95 | 0.93 | 1.00 |
| 200 point reads | 0.99 | 1.01 | 1.01 | 1.08 |
| 100 single inserts | 1.01 | 0.96 | 0.97 | 0.99 |

Every ratio inside the run-to-run spread of its own samples (the 1.08: 198-212 ms against
191-242). The signalled 50 000-row insert kept all its rows, every time. **Not measured:** the
same under concurrent connections; any other VFS under a yielding statement — in particular whether
`OPFSAdaptiveVFS` can hand its rotated handle over mid-statement between clients.

**Fixed on `fix/idb-long-read` (`133d51a`), 2026-09-14.** `yieldsDuringStatements`, true for this
VFS only, makes the worker yield on every statement there. `tests/browser/idb-long-read.test.ts`
failed before it on both engines and both builds, and passes after. **Safari 26.6.2 macOS, the
user's console probe on preview `4340da6`** (`.scratchpad/idb-safari-yield-2026-09-14/safari-paste-v3.js`):
a read issued 50 ms into an unsignalled self-join won 3/3, 2-3 ms against 343-355 ms. The worker
tick costs 0.05 ms there (0.002-0.005 on Chromium and Firefox), and a signal adds nothing
measurable to MemoryAsyncVFS (19-21 against 20-22 ms). Before a Safari restart the same probe
could not open `IDBBatchAtomicVFS` at all — `create` and `deleteDatabase` hung past 20 s — in a
tab where an earlier probe had left a client stuck: the blocked-origin case ("A tab on the origin
blocks two columns", below), not the fix.

**The bench's `null` on Safari, traced — an intermittent stall, not the fix.** Console probes on
the user's Safari 26.6.2 (`.scratchpad/idb-safari-yield-2026-09-14/safari-paste-v4..v7.js`):
- **The yield costs Safari nothing.** The bench's own cross-join at bounds 25/50/100, preview
  (yields) against the rc.4 page (never yields): IDBBatchAtomicVFS 52/97/190 against 49/95/194 ms,
  MemoryAsyncVFS the same, signal or not — ~1.9 ms per bound unit, as on Chromium.
- **The calibration succeeds at `poolSize` 4** — bound 1 208, verified in 1 937 ms — **until one
  sample stalls.** After the bench's earlier writes (single inserts, reads, a scan, 500 inserts and
  500 UPDATEs in transactions), bound 1026 cost 1 642 ms and the very next run of the same statement
  **38 013 ms**. On the rc.4 page, so it predates the fix.
- **Not a stall — a slowdown that holds.** v7's 48 further runs saw nothing, but none of them ran
  a ~1.6 s statement twice. The bench at `a85c273`, same Safari, IDBBatchAtomicVFS pool 4, with
  every timing exported (`longQueryCalibration`): attempts 200 → 428 ms and 935 → 1 639 ms, then
  the three verifications of bound 935 at **25 432, 33 896 and 34 289 ms**. So after the bench's
  writes, the statement that just took 1.6 s takes 15-20× that on every later run — on the rc.4 page
  too (v6), so it predates the fix. Retrying the verification does not help; `a85c273`'s premise
  that "a stall misses one" is refuted, and its comment in the bench is wrong until rewritten.
  Cause unknown; `mem:follow-ups`.
- **It degrades run by run, not at once** (v8, preview, same Safari, after the same writes, the
  first worker running every statement): successive long reads of ~900 bound ran **1 596, 1 570,
  3 683, 33 582 ms** at `poolSize` 4 and **1 706, 1 672, 10 205, 35 389 ms** at `poolSize` 1. The
  third was a new SQL text, so not the statement cache; a point read between them took 2-3 ms, so
  not a wait; pool 1 matches pool 4, so not routing. The bench's calibration met it on its third
  long statement (attempt 200, attempt ~935, verification); it now skips a verification the search
  already timed, which makes the race the third.
- **Not the IndexedDB request path** (v9, preview, same Safari, pool 1, after the same writes). At
  the default cache the four long reads ran 1 642, 1 629, 1 555, **22 660 ms**; at
  `cache_size = -32000`, where the whole table stays in SQLite's page cache and the long reads stop
  reaching IndexedDB after the first, **1 909, 1 759, 4 401, 38 113 ms**. And a full scan served
  from that cache went from 12/11 ms before the long reads to 80/78 ms after — the worker's own
  execution slows, not its reads. A larger cache is no workaround.
- **The bench answers on Safari since `5052d4f`.** Served from the container's `_site` on
  `localhost:8099`, Safari 26.6.2, IDBBatchAtomicVFS/async at `poolSize` 4:
  `reads-during-long-query` **true**, calibration 200 → 430 ms and 930 → 1 591 ms, no verification
  run, `reasons` empty (`.bench/browser-sqlite-20260914181700-…`). Its label reads `a85c273`: the
  page was built before `5052d4f` was committed, from the same tree.

## SAFARI-CAP — the pool caps hold on Safari and Firefox, 2026-09-14, the user's Mac + this container

Bench exports in `.bench/`. Safari 26.6.2 macOS, `readwriteUnsafe: false`: one run at preview
`5db2c8b` (`…20260914142953…`), three at preview `29fbc71` (`…150411…`, `…150425…`, `…150436…`).
Firefox 153 linux, this container: three at `main@29fbc71` (`…130632…`, `…130832…`, `…131030…`).
`poolSize` **1** on every column of `OPFSWriteAheadVFS`, `OPFSAdaptiveVFS` and `OPFSCoopSyncVFS`,
every build, every run; `reasons` empty; conformance all pass. At `5db2c8b` the page still "passed"
the two two-worker rows on WriteAhead and Adaptive at one worker — the BENCH-DRIFT copy had not
followed conformance's `oneWorkerHere`; since `29fbc71` they report `skipped`, and so does
`reads-during-long-query`. The console at `5db2c8b` (the user's screenshot) showed only the cap
warnings — eight for WriteAhead, four for Adaptive, one per bench client since the page passes
`poolSize: 4`, none for CoopSync — and no `lost` line, no wa-sqlite error pair, no `jDelete` error.

**`OPFSWriteAheadVFS`'s lead over `OPFSAdaptiveVFS` holds at equal pool** — every column below
ran one worker. Medians of 3 runs, ms; Safari and Firefox are different machines, so compare
within an engine only.

| Safari | WA sync | WA async | Adaptive async | CoopSync sync | CoopSync async |
|---|---|---|---|---|---|
| write p50 | 0.4 | 0.4 | 1.2 | 0.6 | 0.6 |
| point read p50 | 0.25 | 0.25 | 0.55 | 0.25 | 0.3 |
| transaction | 25 | 29 | 34 | 26 | 33 |

| Firefox | WA sync | WA async | WA jspi | Adaptive async | Adaptive jspi | CoopSync sync | CoopSync async | CoopSync jspi |
|---|---|---|---|---|---|---|---|---|
| write p50 | 1.2 | 1.4 | 1.4 | 3.4 | 3.6 | 1.8 | 1.8 | 2.2 |
| point read p50 | 0.4 | 0.4 | 0.5 | 0.85 | 0.9 | 0.4 | 0.45 | 0.55 |
| transaction | 64 | 68 | 71 | 66 | 73 | 66 | 65 | 71 |

So the 2026-09-04 gap was not pool size: Adaptive writes and point reads cost 2-3× WriteAhead's on
both engines, build for build; transactions are close on Firefox.

## WORKER-LOST — why `OPFSWriteAheadVFS` lost workers off Chromium, 2026-09-13/14, this container + the user's devices

Method and full tables: spec `docs/superpowers/specs/2026-09-13-pool-environment-cap-design.md`
§6; probes and logs in `.scratchpad/worker-lost/`. Firefox 3 runs per probe, Chromium control.

- **Structural, not a race:** `OPFSWriteAheadVFS` at `poolSize` 1/2/4 lost 0/1/3 workers on Firefox,
  3/3 runs, on all three builds; 0 on Chromium; `OPFSAdaptiveVFS` at 4 lost none anywhere. Which
  slot survived varied — the race is for the VFS's `#open` lock.
- **Cause:** a second `createSyncAccessHandle({ mode: 'readwrite-unsafe' })` on a held file rejects
  — `NoModificationAllowedError` on Firefox, `InvalidStateError` on Safari (WebKit's exclusive
  `acquireLockForFile`); `h.mode` is undefined off Chromium, so the option is ignored.
- **The probe that fixes it:** `'mode' in FileSystemSyncAccessHandle.prototype` in a dedicated
  worker — Chromium true, Firefox false, Safari false (the user, in Safari's console);
  `typeof FileSystemSyncAccessHandle` is `"undefined"` in the page on both local engines.
- Each failed open printed two console lines — `jOpen`'s empty `e.stack`, then `jGetLastError`'s
  error: six pairs at `poolSize` 4 (the user's Safari and Firefox consoles, preview page).
- **Why nothing saw it:** rstest's markdown reporter omits a passing test's console; with
  `--reporter default` the Firefox suite printed 12 `lost` lines, every one intended.

## POOL-SIZE — a pool buys nothing on a rotated exclusive handle, 2026-09-14, this container

Method and table: spec §10.1; probes in `.scratchpad/pool-size-probe/`. Fresh client per sample,
sizes 1/2/4 rotated per iteration, 2 warm-ups + 5 measured, 3 runs per engine, medians, 2 000 rows.

- **Firefox `OPFSAdaptiveVFS` (reduced):** startup 70-76 ms @1 against 129-136 @4; five bursts of
  eight reads 71-74 against 117-130; a read during an open write transaction ≈ 265 ms at every
  size; a table read during a long table query waits out the query at every size.
- **`OPFSCoopSyncVFS`:** bursts 44-47 @1 against 118-129 @4 on Firefox, 25-28 against 86-94 on
  Chromium; a read during a write transaction waits at every size, on both.
- **Control, Chromium `OPFSAdaptiveVFS`:** bursts 60-82 @1 against 44-53 @4; a read during a write
  transaction 263 ms @1, 3 ms @2 and @4 — the probe does discriminate.
- The one cost of a pool of one found: a query touching no table waits behind a long query instead
  of running beside it. Point reads, writes, transactions and scans: equal at every size.
- The first long-query arm touched no table and measured nothing (`mem:lessons`). Not measured:
  Safari; anything across tabs.

## DELETE-WA — `deleteDatabase` left `OPFSWriteAheadVFS`'s write-ahead files, 2026-09-14, both engines

Probe `.scratchpad/worker-lost/probe-delete.test.ts`: create, write, close, delete, list the OPFS
root. `OPFSWriteAheadVFS`: `(db)`, `-wa0`, `-wa1` before, **`-wa0`, `-wa1` after**;
`OPFSAdaptiveVFS`: `(db)` before, nothing after. Each deletion also printed three console errors —
its `jDelete` refuses every file but its own temporaries. Fixed by `extraFileSuffixes` and an
OPFS-only pass for the `opfs-path` layout (39d0dd4). Orphans from earlier deletions stay, and are
harmless: the VFS truncates them when it creates a database of that name.

## TX-M1M2 — a write stopped after its first row, and the savepoint premise, 2026-09-11, all three configurations

**Method.** Throwaway probe `.scratchpad/savepoint-probe/m1m2.test.ts`, copied into
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

**Method.** Throwaway probe `.scratchpad/savepoint-probe/probe.test.ts`, copied into
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
suite does the same: `.scratchpad/closure-baseline/test.txt` captured no console output.

**M3 — the real B's cost, 2026-09-11, this container, both engines.** Method: probe
`.scratchpad/savepoint-probe/probe-m3.test.ts`, copied to `tests/browser/zz-m3.test.ts` for
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

**Method.** Throwaway probes `.scratchpad/probe-autocommit/persistent.test.ts` (chromium and
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

**Method.** Throwaway probes `.scratchpad/probe-autocommit/rollback.test.ts` and
`afterend.test.ts`, default `OPFSAdaptiveVFS`/`async`, `poolSize: 1` so the next transaction
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

**Method.** Throwaway probe `.scratchpad/probe-autocommit/m1.test.ts`, three runs per case.
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

**Method.** Probe `.scratchpad/tx-quiesce-probe.test.ts`, run as a browser test on the
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

## Engine capabilities — 2026-08-24, dedicated worker on secure `http://localhost`

Playwright's own builds: Chromium 151, Firefox 153, WebKit 26.5, all arm64/Linux.

| engine | `isSecureContext` | `storage.getDirectory` | `FileSystemSyncAccessHandle` | 2nd `readwrite-unsafe` handle |
|---|---|---|---|---|
| Chromium | ✅ | `function` | `function` | **succeeds** — mode honoured |
| Firefox | ✅ | `function` | `function` | **`NoModificationAllowedError`** — mode ignored |
| WebKit (Linux) | ✅ | **`undefined`** | **`undefined`** | — |

- **Firefox is the only engine here that exercises `OPFSAdaptiveVFS`'s degraded path**, and
  it does so correctly: 102/104 browser tests, two concurrent reads overlapping at ratio
  **1.03** (Chromium control 0.88).
- **Firefox is ~5.5× slower than Chromium** on the same CPU-bound query: 4192 ms vs 755 ms
  for `longQuery(3_000_000)`. **Every Chromium-calibrated timing constant in the suite is
  suspect.**
- **WebKit on Linux has no `navigator.storage` at all** — not a partial OPFS, the whole
  StorageManager is missing. It cannot exercise any VFS this library ships and was removed
  from CI and the devcontainer (`ee2e9f3`). A real WebKit signal needs Playwright on
  **macOS**. Its 9/104 was one missing API, not 95 defects.

## Cross-connection staleness — 2026-08-20, `poolSize` 4, Chromium

| VFS | stale reads |
|---|---|
| `OPFSPermutedVFS` | 85 in 360 (≈24 %) — this is why it was deleted |
| `OPFSAdaptiveVFS` | **0 in 360**, and 0/80 on each of four axes: data INSERT, table CREATE, table DROP, and a table replaced under the same name with a different shape |
| `IDBBatchAtomicVFS` | 0 |
| `OPFSWriteAheadVFS` | stale 12/12 across its three builds — the "WAL inside the VFS might behave differently" lead is **dead** |

**Staleness is not a property of any one VFS**: measured identical on every VFS and every
build (40 runs, 40 stale) on the shape that matters. That is why the barrier is permanent
architecture. See `mem:architecture`.

## The barrier's domain — 2026-08-21, barrier disabled, forced configuration

**It needs DDL without material growth of the file.** A write growing the file 3 → 253
pages left the primed connection **fresh 3/3**; a tiny write leaving it at 2 pages left it
**stale 3/3**, and 3/3 on each of six structural variants — eighteen runs, all stale. The
growth is the only difference.

Mechanism **inferred, not observed**: a file-size mismatch check that re-reads page 1
through a path the change-counter bug does not defeat. It explains why `output()` was
always the reliable trigger — small staging table, no growth, nothing auto-heals.
**Do not turn this into "skip the barrier after a large write"**: that rests on the
inference and on one growth ratio at one page size.

**The trigger is priming, not lag.** Correlation was total at `poolSize: 2`: everything on
`w0` (the writer) → correct; writes on `w1` with the final read on `w0` → stale, every
time. The stale row was `{"old_col": 42}` — the **new** data under the **old** column name,
i.e. a stale page 1 with fresh data pages: an *incoherent* snapshot, not a coherent lagging
one. Any earlier read on the connection that later serves the read is enough to prime it.

**Prelude census** (poolSize 2, 20 rounds, 21 commits): alternating 1 prelude /
perWorker [41,0]; mixed concurrent 14-17 / [21,20]; read-heavy 5 / [25,20]. The mixed
figure sits near the theoretical ceiling of one prelude per commit per other worker.

## Writer stickiness released — 2026-08-21, `e2f454b`

poolSize 2, a long read holding worker 0: five writes in **30-32 ms** spread onto worker 1,
against **934-1052 ms** queued behind the read — ~31×. Cost: one extra prelude.

**On alternating, mixed and read-heavy loads it is neutral on preludes *and* on wall
clock**, three runs each. This is a fix for the pathological case, not a throughput win —
do not claim otherwise. The spec's §2.2 claim that it would mitigate the barrier's
alternating-load worst case is **not confirmed**.

Earlier, 2026-08-20: with a temporary scheduler rotation forcing every write onto a
different worker, 45 schema-dependent writes (`CREATE` → `INSERT` → `ALTER` chains) spread
over all four workers, **zero errors**, where wave 3 had measured `no such table` against
Permuted. Both controls pass. Honest limit: this cannot demonstrate the harness would have
caught the Permuted failure, because Permuted is gone.

## Back-pressure (BP-1) — 2026-08-19/20

**Is a `postMessage` delivered to a worker inside a query? No — on all three WASM builds.**
Method: a `ping` every 25 ms during a query; the worker replies `pong` reporting whether a
query was in flight when the handler actually ran.

| build / VFS | load | query | pings | handled **in** query | handled **after** |
|---|---|---|---|---|---|
| Asyncify (`OPFSPermutedVFS`) | CPU | 5160 ms | 206 | **0** | 206 |
| Asyncify | I/O (24 MB scan, `cache_size=10`) | 1063 ms | 42 | **0** | 42 |
| sync (`OPFSCoopSyncVFS`) | CPU | 4116 ms | 164 | **0** | 164 |
| sync | I/O | 1126 ms | 44 | **0** | 44 |
| jspi (`OPFSAdaptiveVFS`) | CPU | 4122 ms | 165 | **0** | — |
| jspi | I/O | 1291 ms | 52 | **0** | — |

**Two controls are what make the zero mean anything, and the first attempt had neither:** a
ping sent while the worker is idle always comes back (the channel works), and every ping
sent during a query is handled immediately after it (nothing is lost — they queue). The
first run reported zero late pongs through a defect in the measurement and would have
proved nothing.

**Does creating a task turn restore delivery? Yes.** Real row loop, real VFS, 4000 chunks
(200k rows, `chunkSize` 50), three passes: baseline without back-pressure 338 ms, abort
**never** delivered; with a `MessageChannel` task turn per chunk, 373-393 ms, abort handled
within **0-1 chunk** at every window size; with a counter only and credits batched 16 at a
time, 340 ms, abort handled **14 chunks late**. So the task turn is load-bearing and its
absence is detectable by a test; credits themselves are free; nothing is gained beyond a
window of 2.

**Cost on the SHIPPED code, 2026-08-20** — 200k-row `read()`, three passes, merged code
against `src/` restored to `c07c92f`. At the default `chunkSize` 500 (400 chunks):
113 → 116 ms, **nothing measurable**. At `chunkSize` 50 (4000 chunks, adversarial):
121 → 170 ms, **12.2 µs per chunk**. A consumer at default settings pays nothing they can
see.

## Concurrent reads by VFS — 2026-08-20, probe `a68047b`, poolSize 4, Chromium

8 reads: `OPFSAdaptiveVFS` 13, 12, 16 ms · `IDBBatchAtomicVFS` 15, 26, 19 ms ·
`OPFSCoopSyncVFS` 29, 35, 33 ms (**2-3× slower than the default**).

## Device campaign — 2026-08-25, real hardware

Read-burst concurrency ratio (higher is better; 1.0 means no concurrency at all):

- `OPFSAdaptiveVFS`: **3.24×** on Chromium, **0.94–1.08×** everywhere else.
- `OPFSAnyContextVFS`: **2.50×** on Firefox before the WebKit patch; after it, **1.70×** on
  WebKit and **2.0–2.2×** on Firefox — the best concurrent-read VFS on both.
- Safari, persistent: `IDBMirrorVFS` bulk 44 ms and transactions 28 ms, against
  `IDBBatchAtomicVFS`'s 77 ms and 31 ms.

## MIRROR-1 — the method matters as much as the number

2026-08-25. A temporary `tests/browser/mirror-probe.test.ts` repeating the failing sequence
unchanged — `CREATE TABLE` → `INSERT` → `SELECT`, `IDBMirrorVFS` at `poolSize: 2`, a fresh
database each round, 60 rounds — with **no instrumentation at all**: no `Worker` wrapper,
no `debug: true`, the count surfaced through the assertion message.

**In isolation: 0/60. Under the full suite: 5 failures across 300 rounds (≈1.7 %), in 4 of
5 runs.** The defect needs contention to appear, which is why every prior sighting was a
pre-commit hook and nobody could reproduce it on demand. Two distinct symptoms, not one:
`no such table` (the predicted stale read) and `database is locked` (`SQLITE_BUSY`, not
predicted).

## Browser baseline — sourced 2026-08-25 from MDN browser-compat-data

`dist/` is published as `syntax: 'esnext'` and nothing is down-levelled. Grepped from the
built output it uses logical assignment, private class fields, top-level `await`,
`crypto.randomUUID()`, `Array.prototype.at()` and `structuredClone()`.

| feature | Chrome | Firefox | Safari |
|---|---|---|---|
| logical assignment (`??=`, `\|\|=`) | 85 | 79 | 14 |
| private class fields | 74 | 90 | 14.1 |
| `Array.prototype.at()` | 92 | 90 | 15.4 |
| `crypto.randomUUID()` | 92 | 95 | 15.4 |
| **effective floor** | **92** | **95** | **15.4** |

**The floor is set by the two APIs, not by the syntax.** `structuredClone()` is used once,
in the worker, and is **not** in the table: its BCD entry was not found at
`api/structuredClone.json`, `api/Window/structuredClone.json` or
`api/WorkerGlobalScope/structuredClone.json`, and no number is claimed without one. Still
owed: locate it and confirm it does not raise the floor.

**Top-level `await` is the bench page's requirement, not the library's.** Neither `src/`
nor `dist/` contains a module-level await. A development tool may require a newer browser
than the package.

**A disagreement worth keeping:** BCD records top-level `await` as arriving in **Safari
27**, yet the page uses it and ran on **Safari 26.5.2**. Either the entry is wrong or `27`
means something other than a first supporting version. The observation is direct.

**JSPI:** caniuse gives Firefox **153**, and our own conformance run on Playwright's
Firefox 153 independently detected `WebAssembly.Suspending` and executed all 22 declared
build pairs. Source and observation agree exactly — the strongest state a fact in this
project can be in. Lucky detail: 153 is exactly the first supporting version, so the run
sat on the boundary; on 152 the nine jspi pairs would have skipped with their stated reason
and nothing would have failed. The feature detection was validated by accident.

## Bundler matrix — 2026-08-27, Node 24.13, Chromium via Playwright

Method: the packed tarball installed by npm into a temp dir **outside** the repo, then
**both** the dev server and the production build driven with a real page load asserting
`window.__SMOKE__`. A build that emits is not a pass; the page must read rows back. The
throwaway harness that produced this lives at `.work/bundler-probe.mjs` (gitignored).

| bundler | versions passing | floor, and why it is there |
|---|---|---|
| rsbuild | 1.0.1, 1.7.6, 2.0.0 | `1.0.0` is deprecated **by its authors** ("mistakenly released version") |
| rspack | 1.0.0, 1.7.12, 2.0.0 | none found in the 1.x/2.x range |
| Parcel | 2.0.0, 2.9.0, 2.16.4 | the whole 2.x line works — **only** once `main` exists, see below |
| webpack | 5.60.0\*, 5.90.0, 5.101.0, 5.109.2 | 5.20/5.30 fail; `webpack-cli@7` requires `webpack ≥5.101` anyway |
| Vite | 6.1.0 … 8.2.2 | **6.0.x fails entirely, through 6.0.15** |

\* 5.60 needs `--openssl-legacy-provider`: webpack of that era hashes with MD4, which
OpenSSL 3 removed. Its own defect, not ours, and not worth chasing — webpack stayed on
major 5 throughout, so an old consumer updates without a breaking change.

**Vite 6.0 and Vite 5 fail the same way**, at build *and* dev: `Vite is unable to parse the
worker options as the value is not static` — our `new Worker(url, { name: workerName, … })`
passes a variable. Vite **6.1** lifted it. Testing `6.4.3` and calling the floor "6+" would
have been a lie; the `.0.0` of each major is the only honest probe.

**`optimizeDeps.exclude` is a dev-server fix only.** Without it on 6.1.0 and 7.0.0: dev
fails, `vite build` and the served production bundle pass. Vite **8** needs nothing at all.

**Parcel is the only resolver here that does not read the `exports` map.** It falls back to
`main`, which the package did not declare, so it could not resolve `browser-sqlite` at any
version. One field fixed all three versions. That is why Parcel earns a place in the smoke:
the other four share too much genealogy to catch a packaging gap of that shape.

## Published artifact sizes — 2026-08-27, after `minify` + `sourceMap`

| file | before | after |
|---|---|---|
| `dist/worker/worker.js` | 758 kB / **125** gzip | **302 kB / 84 gzip** |
| `dist/index.js` | 49 kB / 11 gzip | **21 kB / 8 gzip** |
| published tarball | 1215 kB | **1459 kB** (the maps) |

**`mem:stack-and-build` said 117 kB gzip for the worker. That was already stale before this
session** — it measured 125 kB unminified. Corrected there.

The bundlers gain nothing from this: Vite emits 311 kB, rspack 303 kB, webpack 307 kB and
Parcel 310 kB from the same source, each minifying it themselves. The beneficiary is the
no-bundler path and `dist/` copied to a CDN. Source maps carry `sourcesContent` (15/15 and
28/28) and cost nothing at runtime — a browser fetches them only with devtools open.

## Safari campaign — 2026-08-27, real devices, `feat/safari-device-campaign` on Pages

Four exports in `.bench/`: iOS Safari 26.6, macOS Safari 26.5.2, macOS Safari 27.0,
iPadOS Safari 27.0. All four report `readwriteUnsafe: false`. **This is the first campaign
that could measure `OPFSWriteAheadVFS` at all** — the page carried the same
`cap.requires.includes('readwrite-unsafe')` skip the conformance suite did, so the column
was invisible until `70b2b7a`.

**It opens and serves on every one of them**, all builds, all six invariants — with the one
exception below. `no-read-inside-transaction` reads `blocked`, but so does it for **seven
of the nine VFS**, `OPFSAdaptiveVFS` included: that is the reduced-mode signature, not a
property of this VFS.

**Read-burst concurrency ≈ 1.00 — there is none.**

| device | `OPFSWriteAheadVFS` | `OPFSAdaptiveVFS` (control) |
|---|---|---|
| iOS 26.6 | 1.00 | 0.92 |
| macOS 27.0 (`jspi`) | 1.00 | 1.00 |
| iPadOS 27.0 | 1.00–1.20 | 0.98–1.00 |

So it degrades exactly like `OPFSAdaptiveVFS` without `readwrite-unsafe`, which confirms
`degradesWithout` as the right declaration — and means it offers a Safari user nothing over
the recommended default.

**Three rounds over ninety minutes settled what one round could not.** Round 2 followed a
manual clearing of the device's site data; round 3 was the first served by the page
carrying the automatic VFS-name sweep (`a82f0ee`).

- **`AccessHandlePoolVFS` on iOS 26.6: `fail`, `fail`, `pass`.** It was residue after all.
  The manual clearing never reached OPFS — which is exactly why round 2 read as a
  refutation and was not. Round 3 is the sweep working on a real device, on the case it was
  written for. `AccessHandlePoolVFS/jspi` on macOS Chromium 150 passes too, retiring the
  other isolated `opens` failure this project was carrying.
- **`OPFSWriteAheadVFS/sync :: survives-reopen`: one `timeout` in three runs**, on macOS
  27.0 and on iPadOS 27.0, `pass` everywhere else including all three iOS runs and macOS
  Chrome 150. A flake at n=3, not the defect round 1 looked like. See REOPEN-1.
- **`no-read-inside-transaction` flipped in both directions between rounds**, on three VFS.
  The n≥3 rule keeps earning itself.

**What the three rounds taught, and it is not "run more":** two conclusions were written
from one run per device and both were wrong, in opposite directions. The first said a flake
was a defect. The second said a defect was not residue — resting on a manual clearing whose
effect was never verified. **A manual step you did not observe is not evidence**; the page
could have reported whether the OPFS root was empty, and nobody asked it.

## Web Locks priced — 2026-08-31, Chromium 151 / Firefox 153, this container

**Method.** Throwaway `tests/browser/locks-probe.test.ts` (deleted), headless, 16 cores,
origin empty at start (`query()` reported 0 held). Three runs per cell, medians below;
every figure is a **batch total divided by its count** — 1000 hold/release cycles, 500
`query()` calls — never a single timed call, because Firefox reduces `performance.now()`
to 1 ms. Control (`await Promise.resolve()` in the same loop): 0.0001 ms Chromium,
0.0030 ms Firefox, so no figure below contains its loop.

| | Chromium | Firefox |
|---|---|---|
| `hold`+`release`, exclusive | **0.0732 ms** | **0.0580 ms** |
| `hold`+`release`, shared | 0.0629 ms | 0.0530 ms |
| `query()`, 0 held | 0.0310 | 0.0340 |
| `query()`, 8 held | 0.0360 | 0.0360 |
| `query()`, 64 held | 0.0626 | 0.0680 |
| `query()`, 256 held | 0.1326 | 0.1560 |
| `query()`, 512 held | 0.2236 | 0.2980 |

**`navigator.locks.query()` is O(n) in the locks held by the WHOLE ORIGIN**, not flat, and
cleanly so: `≈ 0.032 ms + 0.00038 ms × n` on Chromium, `≈ 0.034 + 0.00052 × n` on Firefox.
The 64→512 slope equals the 0→512 slope on both engines, which is what makes it linear
rather than an artefact. **The 0.2 ms budget is crossed near 450 held locks on Chromium
and 320 on Firefox.**

**The decision it settled, and half the rule failed.** The rule was set before the run:
the cross-tab epoch registry is viable if `query()` is ≤ 0.2 ms **and** flat. It is the
first and not the second. Taken anyway, on this basis: our own contribution was ≤ 1 marker
per tab per database, so a plausible origin holds 60–120 and pays 0.06–0.08 ms — three to
six times less than the ~0.2 ms worker round trip the registry avoids, and the registry
also *skips* the barrier when nothing changed where the unconditional prelude cannot.
**The residual exposure is that the count is not ours:** an application using Web Locks
heavily makes us pay for its locks on every `query()`. A fallback to the unconditional
prelude above a threshold is possible and was not built.

**The budget sentence above is superseded, 2026-09-03: it is now ≤ 2 markers per CLIENT
per database.** Database inspection added `bsq:client:<ns>:<file>:<uuid>:<vfs>:<label>`,
held for every client's life on every persistent VFS. The arithmetic changes more than it
looks: the epoch marker is one per tab, this one is one per client, and a tab with four
clients on two databases now contributes eight rather than two. It stays far from the
threshold — 450 held locks on Chromium, 320 on Firefox — but the figure to re-derive when
someone next reasons about `query()`'s cost is this one, not the one above.

**The 256 and 512 points exist because the first run only went to 64** and showed growth
where flatness was expected. Extrapolating that slope was the obvious move and is exactly
what this project keeps paying for; they were measured instead.

Also settled: **the rc.5 write lock costs 0.058–0.073 ms per write** against a commit
measured at 3.4–5.3 ms — under a percent. And a shared read lock would cost 0.053–0.063 ms
per read, ~5 % of a 1.1 ms read; not needed by the chosen design.

n=3, one machine, headless, one container. The two engines agree closely.

## Cross-tab coordination priced as COUNTS — 2026-09-01, Chromium 151 / Firefox 153, this container

**Method.** Throwaway `tests/browser/cross-tab-probe.test.ts` (deleted). `navigator.locks.query`
and `navigator.locks.request` wrapped in the test page before the client is created and counted
by name prefix; `BARRIER_SQL` executions counted through `db.debug` the way
`tests/browser/barrier.test.ts` does. The before/after arm ran the same workload in a scratch
`git worktree` at `git merge-base main HEAD`. **Every figure below is a count. No durations
were taken, deliberately** — the effect is ~0.03 ms, Firefox clamps `performance.now()` to 1 ms,
and this project has already paid once for timing an effect this size.

| | Chromium | Firefox |
|---|---|---|
| `query()` per **read** | 1 | 1 |
| `query()` per **write** | 1 | 1 |
| `request(bsq:write:…)` per write | 1 | 1 |
| `request(bsq:epoch:…)` per write | 1 | 1 |
| `BARRIER_SQL`, mixed workload, **this branch** | 0 | 0 |
| `BARRIER_SQL`, same workload, **branch point** | 0 | 0 |
| `BARRIER_SQL`, 5 reads, no foreign marker | 0 | 0 |
| `BARRIER_SQL`, 5 reads, foreign marker held | **1** | **1** |

**The two numbers that matter.** A single-tab application runs **no extra barrier
statements**: identical to the branch point on both engines, so the `query()` is the whole of
what it pays. And a foreign commit costs **one barrier per worker, not one per read** — the
first read on a worker that is behind runs it, that worker is then current, and the reads after
it run nothing.

**A caveat the probe reported against itself, and it is right to.** The mixed workload produced
zero barriers on *both* arms, so the before/after comparison establishes "no regression" without
ever exercising the barrier. The cause is `lastWriterIndex`: alternating write→read routes the
read back to the worker that just wrote, which is always current, so the other worker never
serves a read. Not a probe defect — it faithfully measures that workload — but a workload that
forces reads onto a cold worker would be a stronger arm, and nobody has run one.

## Two clients on a `multiConnection: false` VFS — 2026-09-01, n=3 per engine

**Method.** Throwaway `tests/browser/multiconnection-probe.test.ts` (deleted). Two clients in
one page on one database name, `poolSize: 1` everywhere, `openTimeout: 5000` so a stall stays
inside the test budget. **Two clients in one page are a faithful stand-in for two tabs here** —
OPFS access handles and IndexedDB are origin-scoped. (The commit epoch is not, but it is not
part of this question.) Chromium 151 / Firefox 153, this devcontainer.

| VFS | 2nd client opens | data shared |
|---|---|---|
| `OPFSAdaptiveVFS` *(control)* | yes | **yes** |
| `IDBBatchAtomicVFS` *(control)* | yes | **yes** |
| **`AccessHandlePoolVFS`** | **yes, and broken** | **no** |
| `IDBMirrorVFS` | yes | **yes, immediately** |
| `MemoryVFS` / `MemoryAsyncVFS` | yes | no — isolated by construction |

### AHP-2TAB — `AccessHandlePoolVFS` fails silently, and it can break the FIRST client

Two clients created **before either queries**, n=3 per engine:

- **The second client resolves `SELECT 1` in 6 runs of 6, and cannot read any table in 6 of 6**
  (`no such table`). It looks healthy and is useless. A guard that probes an open with
  `SELECT 1` gives a false positive here — and so would `SELECT count(*) FROM sqlite_master`,
  which returns 0 rather than erroring on a frozen empty view.
- **Which client loses the handle race is non-deterministic**, and it is sometimes the FIRST
  one: client A crashed with `WORKER_CRASHED` in 1 of 3 Chromium runs and 2 of 3 Firefox runs.
  So two concurrent clients leave **at least one broken client, always, and sometimes both**.
- Created **sequentially** instead — B after A has run a query — B fails cleanly with
  `WORKER_CRASHED`, 3/3 on both engines, message stable within an engine but **different
  between them** (Chromium names `createSyncAccessHandle`, Firefox says "No modification
  allowed"). Matching on the message rather than the code will not port.
- After `A.close()`, B opens, 3/3 both engines.

**This is pre-existing, not caused by the cross-tab work.** It matters more now only because
the README began promising cross-tab write serialization.

### `IDBMirrorVFS` does share across clients

B sees A's row every time, 3/3 on both engines, **isolated runs**. So `multiConnection: false`
does not mean "isolated from other clients" — it flags concurrent-writer unsafety. This does
**not** refute MIRROR-1 (5 failures in 300 rounds, ~1.7 %): that was measured under a loaded
suite, and 0/60 in isolation. Loaded behaviour across clients was not probed here.

Wall-clock open timings in the report are single observations and are recorded as such.

## DELETE-LIVE — `deleteDatabase` under a live connection, 2026-09-02, n=3 per engine

**Method.** Throwaway `tests/browser/delete-live-connection-probe.test.ts`. Open a client,
create a table, insert and read back a row so the connection is demonstrably working, then call
`deleteDatabase` **with that client still open**. Fresh database name per case, storage cleaned
between cases, each VFS at its declared `maxPoolSize`. Chromium 151 / Firefox 153, this
devcontainer. **Identical on both engines, 3/3, no variation between runs.**

| VFS | outcome | data destroyed |
|---|---|---|
| `OPFSAdaptiveVFS` | throws `WORKER_CRASHED` | no |
| `OPFSCoopSyncVFS` | throws `WORKER_CRASHED` | no |
| `OPFSWriteAheadVFS` | throws `WORKER_CRASHED` | no |
| `AccessHandlePoolVFS` | throws `WORKER_CRASHED` | no |
| **`OPFSAnyContextVFS`** | **resolves** | **YES** |
| **`IDBBatchAtomicVFS`** | **resolves** | **YES** |
| **`IDBMirrorVFS`** | **resolves** | **YES** |

Controls: after `close()`, `deleteDatabase` resolves on every VFS, both engines.

**The README's sentence is wrong on both halves.** It claims a database that is open cannot be
deleted, and that `BUSY` is reported. Three VFS delete it. The four that survive report
`WORKER_CRASHED`, never `BUSY`.

**The protection on those four is accidental.** It is OPFS access-handle exclusivity: the
delete worker cannot open its own handles while the live client holds them, so it crashes. It
is an operating-system-level constraint that `deleteDatabase` was never designed around, and it
disappears for any VFS that does not hold exclusive handles. `bsq:init` plays no part — a live
client does not hold it, since `worker.ts` releases it when the open finishes.

**The three failure shapes differ, and `IDBMirrorVFS`'s is the worst:** after the delete
resolves, its live client keeps reading its correct row out of the in-memory mirror, with no
error and no signal, while a fresh client finds an empty database. `IDBBatchAtomicVFS` — **the
one persistent multi-connection VFS that works on all three desktop engines** — leaves the live
client hanging on any subsequent read. `OPFSAnyContextVFS` at least errors immediately.

**`AccessHandlePoolVFS`'s new `bsq:conn` guard plays no role here**: `deleteDatabase` contests
`bsq:init` only.

## `navigator.locks.query()` counts shared holders one by one — 2026-09-02, both engines

**Method.** Throwaway `tests/browser/query-holders-probe.test.ts` (deleted). The same name held
in `mode: 'shared'` from N contexts, then `query()`, counting entries carrying that name. Done
both same-realm (N holds from the page) and cross-realm (N same-origin iframes, via
`tests/browser/helpers/realm.ts`). Chromium 151 / Firefox 153, this devcontainer. **The two
engines agree completely.**

| N | same-realm entries | cross-realm entries |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | 2 |
| 4 | 4 | 4 |

**So a per-client shared lifetime lock is countable**, which is what the DELETE-LIVE remedy
rests on. The assumption held; it was checked rather than reasoned.

**`LockInfo` carries exactly three keys on both engines** — no extras beyond the specification:

```json
{ "clientId": "94621D6D…", "mode": "shared", "name": "bsq:conn:opfs:app.db" }
```

**`clientId` is realm-scoped, not hold-scoped, and this is the part that matters for any API
built on it.** N holds from one page produce N entries carrying **one** `clientId`; N holds
from N iframes produce N entries with N distinct ones. So the two questions have two different
answers from one query:

- **how many clients** → `entries.length`, valid only if the design enforces exactly one hold
  per client;
- **how many tabs** → `new Set(entries.map(e => e.clientId)).size`.

Using `clientId` for the client count would undercount several clients in one page. Using
`entries.length` for the tab count would overcount them.

**An iframe is a separate Web Locks client.** Anything in this library that ever requested a
lock from inside an iframe would be counted as an independent client.

## A delete cannot slip past a client under construction — 2026-09-02, 20 runs per engine

**Method.** `tests/browser/delete.test.ts`, kept: `createSQLiteClient` and `deleteDatabase` issued in
**one synchronous task**, client first, no `await` between them. Twenty runs on Chromium 151 and
twenty on Firefox 153, this devcontainer. **20/20 refused with `DATABASE_IN_USE` on each engine, no
variation.**

A client's connection lock is *requested* synchronously at construction but *granted* asynchronously,
so the window is real in principle. The Web Locks queue being FIFO per name is what closes it: the
client's request is processed first, and the delete's `ifAvailable` request meets it pending and is
refused. **That was a reading of a specification until this measurement** — and it is the sixth claim
of that shape on this branch, the first five of which turned out false when finally tested.

The result rests on one property of the production code: `locks.hold` is called in
`createSQLiteClient`'s own body, and `hold` calls `manager.request` synchronously inside its Promise
executor. Move either behind an `await` and the window reopens without any test noticing.

## CROSS-VFS — deleting through the "wrong" VFS destroys data, 2026-09-02, n=3 per case per engine

**Method.** Throwaway `tests/browser/cross-vfs-probe.test.ts` (deleted). Create with VFS **A**, write a
row, `close()`, `deleteDatabase(name, { vfs: B })`, reopen with **A**, check the row. `poolSize: 1`
throughout. Chromium 151 / Firefox 153, this devcontainer. **Both engines agreed on every case, and
`deleteDatabase` RESOLVED in all seven — it never reported anything.**

| A | B | layouts | row survived |
|---|---|---|---|
| `OPFSAdaptiveVFS` | `OPFSCoopSyncVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `OPFSAnyContextVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSCoopSyncVFS` | `OPFSAdaptiveVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `OPFSWriteAheadVFS` | opfs-path → opfs-path | **destroyed** |
| `OPFSAdaptiveVFS` | `IDBBatchAtomicVFS` | opfs-path → idb-store | survived |
| `OPFSAdaptiveVFS` | `AccessHandlePoolVFS` | opfs-path → opfs-pool | survived |
| `IDBBatchAtomicVFS` | `IDBMirrorVFS` | idb-store → idb-store | survived |

**So the README's reassurance — "deleting through the wrong one deletes nothing and reports success" —
is true only ACROSS layout families and false WITHIN `opfs-path`, in the dangerous direction.** All
four members of that family resolve one database name to the same OPFS file, which is why this
library's lock names derive from `layout` and never from the VFS name. The doc and the lock keys had
been saying opposite things.

**Read-visibility, the sentence's other half, is not a clean yes or no.** Same family, no deletion:
Adaptive→CoopSync visible, Adaptive→AnyContext visible, Adaptive→WriteAhead visible — but
CoopSync→Adaptive **not** visible, 3/3 both engines, while the delete in that same direction still
destroyed the data. The likely cause is the build rather than the VFS: `OPFSCoopSyncVFS` defaults to
`sync` and `OPFSAdaptiveVFS` to `async`. **Deletion does not care** — it removes a file, it does not
read one — which is exactly why "not visible" cannot be used to argue "deletes nothing".

## VFS-MEDIAN — what settled the recommendation, 2026-09-08, n≥3 per cell

**Method, and the two traps it had to avoid.** Medians per `(vfs, build)` per platform over
the bench exports of the CURRENT metric schema, computed by `.scratchpad/vfs-medians.mjs`
and `.scratchpad/vfs-table.mjs` (kept: they are what re-derives this).

- **The corpus is split by SCHEMA, not only by date.** `mem:follow-ups` asked for the exports
  dated 2026-09-02 or later — that split was chosen for the deletion rewrite. It does not
  align with the bench's own change: `DATASET_ROWS` moved 10 000 → 100 000, renaming
  `bulk-insert-10k` to `bulk-insert-dataset` and replacing `pool-blocking` with
  `overwrite-throughput` + `reads-during-long-query`. Every dataset-sized row measures a
  different thing on either side of it. **The two eras are not poolable**, and pooling them
  is what would have produced a verdict on n=8 that was really n=4 of each.
- **A measurement is a number, `null`, OR one of `"not-run"` / `"timeout"` / `"skipped"`.**
  `null` means below 2× the device clock — too FAST to time, so dropping nulls biases
  against the quicker VFS. The three strings are outcomes and must never reach a numeric
  sort; feeding them to one produced `NaN` medians before the guard existed. Neither pair
  compared below carries any string, so the verdict is clean.

**Platform cells, current schema:** iOS+iPadOS n=5 (one platform, user 2026-09-08), Safari
macOS n=5, Firefox 154 n=5, Chrome macOS 150 n=3, Chrome Android 145 n=3.

**`OPFSWriteAheadVFS/sync` against `OPFSAdaptiveVFS/async`**, bulk-insert 100k / overwrite,
in ms:

| platform | WriteAhead | Adaptive |
|---|---|---|
| Chrome macOS | **155 / 32** | 245 / 33 |
| Chrome Android | **259 / 117** | 490 / 140 |
| Firefox | 184 / 124 | 229 / **92** |
| Safari macOS | **167 / 58** | 224 / 55 |
| iOS + iPadOS | **230 / 48** | 391 / 102 |

WriteAhead also leads write latency, point reads, paged reads and scans on every cell. Its
nulls cluster on `write-latency` (2 of 4 runs on three cells) — it is often too fast to
time, so its medians there are computed only from the runs where it was slow enough, and
**the bias runs against it**.

**Concurrency does not separate them, confirmed at n≥3.** `reads-during-long-query` is true
on Chromium for both and false everywhere else for both. Parallel-read gain: Adaptive keeps
a modest edge on Chromium (3.06 vs 2.64 desktop, 2.90 vs 2.67 Android) and none elsewhere
(~1.0 both). On Android that edge costs 1.85× on bulk — a small gain at a large price.

**Two claims in the docs were false and were removed on this evidence.** `OPFSCoopSyncVFS`
never edges WriteAhead on scans — `AccessHandlePoolVFS` does, and only on mobile (7.2 vs 8.0;
on desktop WriteAhead leads at 5.3 vs 5.4). And the `deleteDatabase` TIMEOUT warning against
`OPFSWriteAheadVFS` / `OPFSCoopSyncVFS` has no support: `deleted-is-gone` passes **78/78**
across both VFS since 2026-09-02.

**No Chrome Android data existed in the current schema until the user re-ran it on
2026-09-08.** The two older Android exports are legacy-schema, dated 2026-08-25. Android
ranks identically to desktop Chromium, rank for rank; only absolute values differ (~1.7×).

## EXISTS-PROBE — telling "this database is there" from "it is not", 2026-09-02, n=3 per cell per engine

**Method.** Throwaway probe (deleted). Each persistent VFS in three states — never created, created and
closed, created and closed then deleted — interrogated by two candidate signals. Chromium 151 /
Firefox 153, this devcontainer. **Both engines identical on every cell, no variation.**

### `jAccess` is NOT usable, and the reason matters more than the table

Reliable on four of seven — `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `AccessHandlePoolVFS`,
`IDBBatchAtomicVFS`. On the other three it returns 0 in **every** state, so an existing database and
one that never existed are indistinguishable: `OPFSCoopSyncVFS` consults an in-memory `Set`,
`OPFSWriteAheadVFS` and `IDBMirrorVFS` in-memory `Map`s, none of them seeded from storage at
construction.

**On `IDBMirrorVFS` it is deliberate** — the upstream source says SQLite never calls `xAccess` on a
main database file, so the VFS skips the IndexedDB round trip. We would be reading a field whose
contract explicitly excludes our use. **A signal that is right by luck on four of seven is worse than
none:** right often enough that nobody notices when it is wrong.

### `open_v2` without `SQLITE_OPEN_CREATE` is uniform on all seven

| state | every one of the seven persistent VFS |
|---|---|
| never created | `SQLITE_CANTOPEN` (14) |
| created and closed | **opens** |
| created, closed, deleted | `SQLITE_CANTOPEN` (14) |

One guard covers every VFS, no special cases, because it goes through `jOpen` — the VFS's real notion
of existence, and what SQLite itself does.

Three practical answers that make it usable and not merely correct:

- **The probe handle is closed immediately.** On `AccessHandlePoolVFS` `jClose` leaves the handle
  associated with the VFS *instance* rather than the file, and the delete worker runs the check and
  `jDelete` on that same instance — so nothing is re-acquired and nothing is held against the delete.
- **`CANTOPEN` (14) is distinguishable from the failures it must not swallow.** A corrupt file reaches
  the header read and returns `SQLITE_CORRUPT` (11); a WASM or VFS start-up failure throws before
  `open_v2` is reached at all.
- **It consumes no `AccessHandlePoolVFS` slot.** `getSize()` went 0→0 absent, 1→1 present, 0→0 after
  deletion.

## Numbers that are one observation, not a measurement

- **Android 145 vs 151 differ by a factor 2.6** on bulk insert, same emulator. Regression
  or noise; a single run cannot say.
- **Chrome Android 109 crashes the bench page before any run starts.** The README claims
  `Android 109+` on four VFS rows and the only observation we hold for that version is a
  crash. The init path is short — the two candidates are the un-timeout'd
  `await probeUnsafeHandles()` and the unbounded `while (t1 === t0)` clock spin. Triage:
  banner after 8 s → the probe; frozen page → the spin.
- **`OPFSWriteAheadVFS`'s `bulk-insert-10k` lands at ~1050 ms on macOS Safari, and nowhere
  else.** 1046 and 1049 ms on 26.5.2, 1048 and 1053 ms on 27.0, for the `sync` and `async`
  builds — against 58 and 76 ms for `OPFSAdaptiveVFS` on the same devices, and **41 ms for
  its own `jspi` build**. Four values inside 7 ms of each other is a timer, not a
  throughput. iOS and iPadOS are unremarkable (42–150 ms). One run per device; nothing has
  been traced.
- **`navigator.storage.estimate().usage` reported 1.42 GB** on an origin whose whole OPFS
  root weighed ~1.6 MB. The IndexedDB `IDBMirrorVFS` store carried the rest. `usage` is
  origin-wide, not OPFS-wide.

## Delete campaign — 2026-08-27, six devices, `feat/delete-database` @ `a55a3bd`

The first campaign the benchmark page could complete on every engine. Its
predecessors on the same day stopped for good on Firefox 154 and macOS Safari
27.0; three abort defects were fixed between them (`mem:lessons`).

| device | clock | columns | `deleted-is-gone` | `not-run` cells | burst ratio reported |
|---|---|---|---|---|---|
| macOS Chrome 150 | 0.1 ms | 22 | 17 pass | 0 | 20/22 |
| macOS Firefox 154 | 1 ms | 22 | 14 pass, 3 timeout | 0 | **6/22** |
| macOS Safari 27.0 | 1 ms | 22 | 16 pass, 1 timeout | 0 | 15/22 |
| macOS Safari 26.5.2 | 1 ms | 13 | 9 pass, 1 timeout | 0 | 7/13 |
| iPadOS Safari 27.0 | 1 ms | 22 | 16 pass, 1 timeout | 0 | 19/22 |
| iOS Safari 26.6 | 1 ms | 13 | 10 pass | 0 | 11/13 |

**Zero `not-run` on all six** — the state the earlier runs could not reach at
all, because a wedged column abandoned every row after it.

**The six deletion timeouts sit on two VFS and nowhere else:**
`OPFSWriteAheadVFS` ×4 (Safari 26.5.2 `sync`, iPadOS 27.0 `jspi`, Firefox
`sync` and `async`) and `OPFSCoopSyncVFS` ×2 (Safari 27.0 and Firefox, both
`async`). Never on Chromium, never on iOS 26.6. Both rotate one exclusive OPFS
handle without `readwrite-unsafe` — `HANDLE-1` reaching the delete path.
`DELETE-TIMEOUT-1` in `mem:follow-ups`. **n=1 per device.**

**The concurrency burst was unmeasurable on a 1 ms clock at 24 reads.** The row
refuses a ratio when the median serial total falls below 4× the clock's
resolution; that refusal fired on 16 of 22 Firefox columns — the engine where
`HANDLE-1` makes the answer matter most. Raised to 96 the same day. Chromium
measured 2.15× at 24 and 2.26× at 96 on the same VFS, which is why the ratio is
held to survive the change: it is normalised, and 96 against a pool of 4
saturates it either way. The 96-read numbers are not in this table — the six
runs above predate that commit.

## Last-writer routing — 2026-08-27, throwaway Playwright harness against `dist/`

**The change is proven as a count, not as a duration.** After a write, the next read is
routed to the worker that wrote and pays no `BARRIER_SQL` statement — asserted by
`tests/browser/barrier.test.ts` on Chromium **and** on Firefox, and falsified by deleting
the branch in `takeAvailable`.

**No latency gain is measurable on either engine.** One run per configuration, 200
write→read iterations, `OPFSAdaptiveVFS`.

| | Chromium before | Chromium after | Firefox before | Firefox after |
|---|---|---|---|---|
| read after write, p50 | 1.1 ms | 1.1 ms | 1 ms | 1 ms |
| read after write, mean | 1.115 | 1.107 | 0.750 | 0.705 |
| same, pool 4, mean | 1.208 | 1.131 | 0.755 | 0.780 |
| bulkWrite 10 k, pool 2 | 52.6 ms | 49.1 ms | 43 ms | 43 ms |
| bulkWrite 10 k, pool 4 | 52.5 ms | 51.8 ms | 50 ms | 56 ms |

Differences go both ways between pool sizes, which is what noise looks like at n=1. **Do
not cite any of these as a gain.**

**Two instrument facts worth more than the table.** Firefox reduces `performance.now()` to
1 ms precision by default, so p50 and p95 come back as integers: a sub-millisecond effect
cannot be timed there at all, whatever the run count. And on this machine the saved worker
round trip is worth about 0.2 ms against a 1.1 ms read — inside the noise of any single
run. **For an effect this size, count the round trips; do not time them.** That is what the
barrier test does, and it is the only reason anything could be claimed at all.

The harness itself was throwaway and is not in the repository: it wrote its own page into
`_site/` and drove it with Playwright. Re-creating it is fifteen minutes; the shape is in
the merge commit of `feat/last-writer-routing`.

## Statement-cache gain — 2026-08-28, feat/statement-cache, devcontainer arm64/linux

**Method.** Scratch harness `tests/browser/prepare-bench.test.ts` (deleted), using
`createTestClient` from the existing test helpers. Three workloads, three runs each, two
VFS cells (OPFSCoopSyncVFS/sync build, OPFSAdaptiveVFS/async build), two engines
(Chromium 151, Firefox 153 via Playwright). Control: same build with
`DEFAULT_STATEMENT_CACHE_SIZE=0` — identical code, cache disabled, single variable
difference. `prepared` counter read via `db.debug` with `poolSize: 1`. Footprint via
`_sqlite3_stmt_status(stmt, 99 /* SQLITE_STMTSTATUS_MEMUSED */, 0)` in the worker. `jspi`
not measured — Chromium only, no cross-engine comparison possible; recorded as not
measured.

**WL1 — 2 000 identical reads (`SELECT a FROM t WHERE a = ?`).**
Microbenchmark; percentage means nothing outside its own context.
Observed: the last 50 of 2 000 executions were visible through the 50-entry debug-state
history cap. With cache=0, all 50 compiled (prepared=1 each). With cache=32, none of the
50 compiled (prepared=0 each). The total of 2 000 compiles for cache=0, and the single
first compile for cache=32, are inferred from the workload's structure and the 50-entry
history cap — neither total was directly read.

| engine | VFS/build | before (ms, median) | after (ms, median) | gain | ms/compile saved |
|---|---|---|---|---|---|
| Chromium | sync/OPFSCoopSyncVFS | 573 | 539 | 5.9% | 0.017 |
| Chromium | async/OPFSAdaptiveVFS | 2142 | 1722 | 19.6% | 0.21 |
| Firefox | sync/OPFSCoopSyncVFS | 487 | 417 | 14.4% | 0.035 |
| Firefox | async/OPFSAdaptiveVFS | 1277 | 1148 | 10.1% | 0.065 |

Firefox times are integers (1 ms `performance.now()` resolution). Chromium/async shows the
largest per-compile cost (0.21 ms) because Asyncify suspends the stack on every schema read
inside `sqlite3_prepare_v3`. Firefox/async is lower (0.065 ms) likely due to different
Asyncify implementation. Firefox/async WL1 shows high within-condition variance (1 096–
1 268 ms cache=32, 1 189–1 289 ms cache=0); the 129 ms median difference is real but
marginal — treat the 10.1 % figure as a floor, not a ceiling.

**WL2 — `bulkWrite` 100 000 rows, 5 columns (16 batches, each its own transaction).**
Each batch: BEGIN + INSERT + COMMIT. `prepared` counts INSERT batches only.
Cache=0: 16 INSERT compilations per run. Cache=32: 2 (one full-batch template, one
partial-batch template). 14 INSERT compiles avoided; BEGIN/COMMIT saves additional.
Signal-to-noise: commit + OPFS fsync dominate on some cells; the percentage is
meaningful but not the primary consumer signal.

| engine | VFS/build | before (ms) | after (ms) | gain | ms/INSERT compile saved |
|---|---|---|---|---|---|
| Chromium | sync | 326 | 284 | 12.9% | 3.0 |
| Chromium | async | 399 | 340 | 14.8% | 4.2 |
| Firefox | sync | 531 | 260 | 51.0% | 19.4 |
| Firefox | async | 722 | 350 | 51.5% | 26.6 |

Firefox WL2 gain (~51 %) is anomalously large relative to Chromium (~13–15 %). The 78 680-
character INSERT template is expensive to compile on Firefox regardless of engine; the
cache removes that cost on 14 of 16 batches.

**WL3 — `tx.bulkWrite` 100 000 rows (same batches, one transaction).**
One commit instead of 16; cache warms once by construction. Clearest reading of the
mechanism. Same INSERT compiled count as WL2.

| engine | VFS/build | before (ms) | after (ms) | gain | ms/INSERT compile saved |
|---|---|---|---|---|---|
| Chromium | sync | 266 | 233 | 12.4% | 2.4 |
| Chromium | async | 312 | 261 | 16.3% | 3.6 |
| Firefox | sync | 519 | 247 | 52.4% | 19.4 |
| Firefox | async | 685 | 313 | 54.3% | 26.6 |

**WL2→WL3 gap — pricing the 15 intermediate commits.**
(after-WL2 minus after-WL3, in ms: Chromium sync 51, async 79; Firefox sync 13, async 37.)
Firefox sync 13 ms at 1 ms resolution over 3 runs is near noise; treat as ≤ 13 ms per
15 commits. Chromium sync ~3.4 ms/commit, async ~5.3 ms/commit. This is the first direct
measurement of the intermediate-commit overhead; previously open in `mem:follow-ups`.

**Footprint — `_sqlite3_stmt_status(stmt, SQLITE_STMTSTATUS_MEMUSED=99, 0)`.**
Measured on cache=32 run (Chromium; identical on Firefox — same WASM binary).
`_sqlite3_memory_used()` returns 0 throughout: this build sets
`SQLITE_DEFAULT_MEMSTATUS=0`, disabling allocator tracking. Only `stmtBytes` is available.

| SQL (truncated) | sqlLen (chars) | stmtBytes | bytes/char |
|---|---|---|---|
| `SELECT count(*) FROM sqlite_master` (barrier) | 34 | 1 336 | 39 |
| `CREATE TABLE t (a INTEGER)` | 26 | 1 915 | 74 |
| `INSERT INTO t (a) VALUES (?)` | 28 | 1 283 | 46 |
| `SELECT a FROM t WHERE a = ?` | 27 | 1 352 | 50 |
| `CREATE TABLE t (a INTEGER, b INTEGER, …)` | 70 | 2 003 | 29 |
| Full-batch INSERT (5 cols × 6 553 rows) | 78 680 | 2 433 999 | 31 |
| Partial-batch INSERT (5 cols × 1 705 rows) | 20 504 | 622 863 | 30 |

The bytes/char ratio is **not stable** (29–74 for small statements vs 30–31 for large
ones): no extrapolation rule is possible. The two bulkWrite templates together hold 3.06 MB.
If both are in the 32-entry cache simultaneously (the typical case after a `bulkWrite`
workload), the cache commits ~3 MB. Small statements (SELECT, barrier, small INSERT) add
1–2 KB each and are negligible beside the templates.

**Raw runs (three per cell):**

Chromium cache=32: WL1 sync [511.4, 550.5, 538.7] WL2 sync [288.1, 282.7, 283.9]
WL3 sync [234.4, 232.8, 231.9] WL1 async [1694, 1722.3, 1830.5] WL2 async [340.2, 340.6,
329.9] WL3 async [261, 265.9, 258.2]

Chromium cache=0: WL1 sync [546.8, 572.7, 639.2] WL2 sync [330.3, 326.2, 323.3]
WL3 sync [266.3, 270.1, 264.5] WL1 async [2132.8, 2142, 2229.5] WL2 async [398.4, 415,
399.2] WL3 async [315.8, 311.9, 307.1]

Firefox cache=32: WL1 sync [416, 417, 427] WL2 sync [260, 265, 259] WL3 sync [253, 243,
247] WL1 async [1096, 1268, 1148] WL2 async [352, 350, 339] WL3 async [324, 313, 304]

Firefox cache=0: WL1 sync [487, 480, 501] WL2 sync [534, 531, 531] WL3 sync [520, 519,
516] WL1 async [1189, 1289, 1277] WL2 async [744, 720, 722] WL3 async [685, 685, 698]

## Statement-cache bound in BYTES — 2026-09-02, this container, Chromium 151 / Firefox 153

Two throwaway probes, both deleted: `tests/browser/stmt-bytes-probe.test.ts` (main thread,
MemoryVFS, both WASM builds, no `src/` instrumentation) and
`tests/browser/cache-thrash-probe.test.ts` (a temporary `__unsafeTestStatementCacheSize`
on `InternalSQLiteClientOptions`, reverted). Everything here supersedes the sizing
guesses in `mem:follow-ups`; the 2026-08-28 footprint table above stands unchanged and
is reproduced to within 3 bytes.

### `MEMUSED` is constant over a statement's whole life

`Module._sqlite3_stmt_status(stmt, 99, 0)` read at five points, `SQLITE_PREPARE_PERSISTENT`
as the cache path uses:

| statement | after prepare | after bind | after step | after reset+clear_bindings | 2nd cycle |
|---|---|---|---|---|---|
| `SELECT a FROM t WHERE a = ?` | 1 352 | 1 352 | 1 352 | 1 352 | 1 352 |
| full-batch INSERT, 5 cols × 6 553 rows | 2 434 002 | 2 434 002 | 2 434 002 | 2 434 002 | 2 434 002 |

Identical byte for byte on the `sync` and `async` builds — the 2026-08-28 claim that the
builds agree is now shown, not asserted.

**Three consequences for the design.** A byte budget fed by `MEMUSED` bounds what it
claims to: the reading survives `reset`. The weight can be taken **once, right after
`prepare`** rather than in `settle`, so the cost is known when the decision to retain is
made. And binding 32 765 integers moves it by zero, so the spec's §8.3 worry about a
cached template pinning its bound values does not show up here — **integers only; blobs
and strings allocate elsewhere, and `clear_bindings` in `settle` is what releases them.**

### The largest `bulkWrite` template is the NARROWEST table

`bulk.ts` caps PARAMETERS at `maxVariables = 32766`, so `maxBufferSize = floor(32766 /
columns)`. Part of the footprint follows VALUES **rows**, so one column buys five times the
rows a five-column table gets:

| columns | rows/batch | SQL chars | footprint | bytes/char |
|---|---|---|---|---|
| **1** | 32 766 | 131 097 | **3 530 930 (3,37 MB)** | 26.9 |
| 2 | 16 383 | 98 336 | 2 453 689 (2,34 MB) | 25.0 |
| 5 | 6 553 | 78 689 | 2 434 002 (2,32 MB) | 30.9 |
| 10 | 3 276 | 72 151 | 2 427 264 (2,31 MB) | 33.6 |
| 20 | 1 638 | 68 935 | 2 424 048 (2,31 MB) | 35.2 |
| 50 | 655 | 67 129 | 2 421 842 (2,31 MB) | 36.1 |

Flat at ~2,31 MB from two columns up; the peak is at one column. **So the library's own
generated SQL has a structural ceiling: MAX_STATEMENT_SIZE ≈ 3,4 MB**, and `maxVariables`
is an internal default no caller sets — it is not a consumer option. Consumer-written SQL
has no such ceiling and never will.

### The working set of two concurrent `bulkWrite`s is TWO templates, not four

Batch order was recorded, not assumed: `abababab…` over all 32 batches, so the two writers
do interleave. The two FULL templates alternate for 30 batches; the two partials arrive
once each at `close()`. That is why `cache=2` does not thrash and `cache=1` does.

Workload: two `bulkWrite`s of 100 000 rows, 5 columns, fed concurrently, `poolSize: 1`,
`debug: true`, OPFSAdaptiveVFS / async build, 3 runs per cell, median.

| cache entries | INSERT compilations | Chromium | Firefox |
|---|---|---|---|
| 32 | 4 / 32 | 745 ms | 819 ms |
| 2 | 4 / 32 | 746 ms | 802 ms |
| **1** | **32 / 32** | **888 ms** | **1 718 ms** |
| 0 (control) | 32 / 32 | 874 ms | 1 722 ms |

**`cache=0` is the control and it does two jobs**: it proves the size actually reached the
worker — without it, "4 compiles in both arms" is indistinguishable from an option that
never travelled — and it shows that **`cache=1` is indistinguishable from having no cache
at all.** A budget that cannot hold both templates does not degrade the cache, it cancels
it: **+19 % on Chromium, +110 % on Firefox.**

Raw runs — Chromium: 32 [733.9, 732.6, 730.4] / [676.5, 765.2, 745.4] · 2 [745.7, 764.7,
743.6] · 1 [880.3, 898, 887.8] · 0 [878, 874.3, 872.4]. Firefox: 32 [819, 807, 832] ·
2 [811, 795, 802] · 1 [1718, 1746, 1703] · 0 [1720, 1722, 1727].

### The large templates live on ONE worker, not `poolSize` of them

Same workload at `poolSize: 4`, default cache, both engines: **all 32 INSERT batches served
by worker 0**, 4 distinct SQL, the other three workers never seeing a template. Four reads
issued afterwards did not move the designation. The scheduler designates one writer at a
time and prefers `lastWriterIndex` (`scheduler.ts`), which is the mechanism.

**This falsifies the `× poolSize` multiplier** `mem:follow-ups` used to size the risk.
n=1 on the distribution, one workload, and nothing here says the designation cannot
migrate over a long session — but it did not here, on either engine.

## Per-VFS default PRAGMAs — 2026-09-02, this container, Chromium 151 / Firefox 153

Three throwaway probes, all deleted: `tests/browser/cache-size-probe.test.ts`,
`ahp-wal-probe.test.ts`, `ahp-capacity-probe.test.ts`. The first two ran on both engines.

**The method lesson first, because it inverted a conclusion.** The `cache_size` probe's
first run walked its arms once, in ascending `cache_size` order, and never deleted the
IndexedDB database between them. Three IDENTICAL 100-page workloads came back at 15, 26 and
63 ms — monotonic with *position* as much as with the variable. It would have been published
as "batch-atomic is 2.4x slower". Adding one reversed pass and a per-arm database deletion
reversed the finding. **An arm order that correlates with the variable is not a measurement.**

### `cache_size` is a cap, not a reservation — and not worth defaulting

`IDBBatchAtomicVFS`, async build, main thread, fresh WASM module per arm, heap read from
`module.HEAPU8.length` (exact, and Emscripten never returns it). 3 passes, middle one
reversed, IndexedDB database deleted per arm.

| `cache_size` | pages dirtied | heap cost of the PRAGMA alone | heap cost of the workload | `BEGIN_ATOMIC_WRITE` |
|---|---|---|---|---|
| -2000 (SQLite default) | 100 | **0** | 0 | 1 / 1 / 1 |
| -2000 | 5000 | **0** | 0 | **0 / 0 / 0** |
| -32000 | 100 | **0** | 0 | 1 / 1 / 1 |
| -32000 | 5000 | **0** | **7.38 MiB** | 1 / 1 / 1 |
| -262144 (256 MiB) | 100 | **0** | 0 | 1 / 1 / 1 |

**Zero in 30 runs of 30**, both engines, including a 256 MiB bound. Raising `cache_size`
allocates nothing; the heap grows only as the workload uses it, and 7.38 MiB was identical
byte for byte on both engines. Emscripten never gives it back, so what a raise buys is a
higher permanent high-water mark, not an immediate cost.

**Batch-atomic mode is real and the default misses it:** at `-2000` a 5000-page transaction
never issues `BEGIN_ATOMIC_WRITE` on either engine; at `-32000` it always does.

**But the gain is not there.** Chromium OFF 1190 / 2590 / 3382 ms against ON 1109 / 1067 /
1069; Firefox OFF 1080 / 1194 / 1219 against ON 1141 / 1138 / 1113 — **Firefox shows no
difference at all**, and Chromium's OFF arm degrades run over run, which reads like storage
pressure rather than the mode. **So `cache_size` is not a default.** It fails the
performance half of "more performance without less reliability", on measurement rather than
on the assertion `mem:vfs` used to carry.

### `AccessHandlePoolVFS` + `locking_mode=exclusive` + `journal_mode=wal` — the one default

Through the library itself (`sync` build, `poolSize: 1`), 200 single-statement transactions,
arms alternated `baseline / wal / wal / baseline / baseline / wal` so position cannot pass
for effect.

**The control first:** `journal_mode` reads back `wal` and `locking_mode` reads back
`exclusive` in the WAL arm; `delete` / `normal` in the baseline. Without that readback every
number below would be void.

| | baseline (ms per write) | WAL + exclusive | gain |
|---|---|---|---|
| Chromium, run 1 | 4.164 / 4.694 / 4.739 | 0.885 / 0.903 / 0.966 | **~4.8x** |
| Chromium, run 2 | 3.990 / 4.447 / 4.501 | 0.835 / 0.950 / 0.931 | **~4.7x** |
| Firefox | 2.045 / 2.025 / 1.975 | 0.530 / 0.495 / 0.490 | **~4.0x** |

Ranges do not come close to overlapping. Upstream called it "significantly reduce write
transaction overhead"; it is a factor of four to five.

**No reliability cost, measured.** Ten cycles of create → write → close → **reopen and read
back** → delete: 10/10 on Chromium (twice) and 10/10 on Firefox, one row every time.

**And the capacity fear was wrong.** The VFS holds a FIXED pool of six access handles for the
whole origin — `addCapacity(6)` runs only when `getCapacity() === 0`, so it never grows — and
a WAL database was reasoned to hold two slots permanently against one for a `delete`
database, halving how many databases fit. Measured by creating databases one at a time until
failure: **5 in `delete` mode and 5 in `wal` mode**, both stopping at "unable to open
database file". SQLite removes the `-wal` on a clean close, so it costs no slot at rest.
**Reasoned wrong, measured right.**

That probe's own first run reported 0 for the WAL arm, because a client whose write failed
was never closed and its worker kept the whole handle pool. A failed arm has to close its
client before the next one opens.

## COOPSYNC-BUSY — a protocol step reaching the consumer, 2026-09-03, both engines

Throwaway spike `tests/browser/coopsync-busy-probe.test.ts`, deleted; its tightened form is
`tests/browser/coopsync-retry.test.ts`. Workload: 15 rounds of 8 concurrent operations, one
in three a write, through the public client.

### The defect, and two clauses of `mem:vfs` it falsified

| VFS | poolSize | Chromium | Firefox |
|---|---|---|---|
| `OPFSCoopSyncVFS` | 1 | 0 / 120 | 0 / 120 |
| `OPFSCoopSyncVFS` | **2 (the default)** | 1 failure | 1 failure on one run, 0 on another |
| `OPFSCoopSyncVFS` | 4 | 1 failure, every run | 1 failure, every run |
| `OPFSAdaptiveVFS` | 2 and 4 | **0 / 120** | **0 / 120** |

Always `SQLiteError` code `BUSY`, `sqliteCode: 5`, "database is locked". Always a **read**,
always at index 2 of the batch, at round 1 or 2 — a trigger, not a race: the first read routed
to a worker that does not hold the handle fails while the transfer is in flight, and the pool
then settles.

**`mem:vfs` said "OPFS + `poolSize > 1` outside Chromium — exactly the combination that
fails". Both clauses are wrong:** Chromium fails identically, which is what HANDLE-1 in the
same file already implied (CoopSync rotates one exclusive handle whatever the engine, so
`readwrite-unsafe` buys it nothing), and it happens at the default `poolSize`. The row and
HANDLE-1 had contradicted each other and nobody had noticed.

**`OPFSAdaptiveVFS` is the control that makes this mean anything** — same workload, same pool
sizes, zero failures. Without it, "our concurrency test is too aggressive" would be as good an
explanation.

### One immediate retry clears it — 7 of 7

Re-issuing the same read through the public path (a fresh lease, which is what a fix at that
level inherits), no sleep, up to 20 attempts allowed:

| engine | recoveries | attempts needed | total elapsed, failure + retry |
|---|---|---|---|
| Chromium | 3 | 2, 2, 2 | 12.5 / 10.8 / 12.1 ms |
| Firefox | 4 | 2, 2, 2, 2 | 17 / 16 / 15 / 15 ms |

`stillFailed` was 0 in all 8 sessions. **So: once, and no backoff** — a second failure means
something other than a handle transfer. The event is once per session, not once per round, so
raising n means opening more sessions; more rounds would add nothing.

## REOPEN-1 does not reproduce — device campaign, 2026-09-03 (user's hardware)

**Method.** Seven exports in `.bench/`, taken from the published `/preview/` page — rc.5 code,
badge reading `development build`. Three iPadOS Safari 27.0, two macOS Safari 27.0, two macOS
Chrome 150. The user confirmed the provenance; the export itself could NOT say, which is a gap
now in `mem:follow-ups`.

**`survives-reopen` passes on every persistent VFS, in all seven runs**, `OPFSWriteAheadVFS/sync`
included — on the two devices that produced the original timeouts, and including the first run
of the day on the iPad, which was the condition the REOPEN-1 note singled out. The only
non-pass cells are `MemoryVFS` / `MemoryAsyncVFS` marked `skipped`, which is their documented
behaviour: they are volatile by construction.

**That closes REOPEN-1.** It was opened on "reproduced on two devices", which was two devices
at one run each; five Safari 27 runs on those same two devices now say otherwise. What it does
NOT clear is rc.3 or rc.4 — these runs are rc.5 — and nobody needs it to.

**A false lead recorded so nobody re-runs it.** Two of the three iPadOS runs failed at
`IDBBatchAtomicVFS :: opens` with `Worker 1 did not become ready within 30000 ms`, all eight
rows of the column falling to `not-run`. Against 20 rc.3 exports on iPadOS/iOS where `opens`
passes every time — including back-to-back runs minutes apart — this read as an rc.5
regression. **It is not.** The user had hit a hang on `cleaning…` and RELOADED the page; a
reload never calls `close()`, so the previous page's IndexedDB connection was still held and
the next opens waited out their 30 s. The 20 clean rc.3 runs never had a mid-session reload,
so there was never a comparison. The hang is the real defect and is in `mem:follow-ups`.

## BENCH-SWEEP campaign — 2026-09-03/04, three platforms, `preview` on Pages

**Method.** The bench page's own export, taken from `/preview/` on real hardware. Every
figure below is read from a `sweep` / `opfsRootAtStart` field that did not exist before
2026-09-03 — the page could not previously report any of it.

### The hang was on the IndexedDB side, not OPFS

`BENCH-SWEEP` predicted `removeEntry` against a live OPFS access handle. The first bounded
run on iPadOS Safari 27.0 (2026-09-03 22:52, Re-start straight after a completed run)
reported instead:

```
sweep: {partial: true, listed: true, left: ["idb:IDBBatchAtomicVFS (timed out)"]}
```

Putting the deadline on **both** sides is what caught it. The consequence was measured, not
inferred: both `IDBBatchAtomicVFS` columns then died at `opens` and 14 cells fell to
`not-run`; the other 20 columns were untouched.

### `deleteDatabase` on Safari takes more than 2 s and less than 5 s

The store was **never held permanently**, which was the standing hypothesis. Splitting the
budget — 2 s for an OPFS directory entry, 5 s for an IndexedDB database — made the case
disappear:

| platform | run A | Re-start (B) | `opfsRootAtStart` |
|---|---|---|---|
| iPadOS Safari 27.0 | clean | **clean** | `[]` |
| macOS Safari 27.0 | clean | clean | `[".wa-sqlite"]` |
| macOS Chrome 150 | clean | clean | `[]` |

All six: 22 columns, 146 `pass`, 30 `skipped`, **zero `fail`, zero `not-run`**,
`sweep.partial: false`. Taken 2026-09-04 00:17–00:20 UTC on `preview @ 45574f8`.

**n=1 per platform on the Re-start, and the failure it replaced was also n=1.** What is
established is that the page no longer hangs and names what it could not do. That 5 s is the
right threshold is an observation; `mem:lessons` records the rule it cost.

**Chromium cannot produce this case at all**: `deleteDatabase` on the `IDBBatchAtomicVFS`
store immediately after that column returns `success` in **1 ms** and the database is gone
(`.scratchpad/probe-idb-hold.mjs`, 2026-09-03).

### The unsafe-handle probe leaked its own file, on both engines — closed 2026-09-04

`__probe_unsafe_handles` outlived the probe worker's `finally`: the main thread called
`worker.terminate()` on the probe's message while the cleanup was still awaiting
`getDirectory()`. **4 of 6 Chromium loads left the file behind**, and a macOS Safari 26.6.2
export carried it into `opfsRootAtStart`. One observation per engine had read as a WebKit
quirk — n=1 again.

**The fix was measured against the defect, not asserted.** A throwaway harness ran the old
and the new probe side by side, six fresh contexts each, Playwright, this container
(`.scratchpad/probe-race/`, gitignored):

| engine | old probe | new probe |
|---|---|---|
| Chromium 151.0.7922.34 | **4/6** loads left the file | **0/6** |
| Firefox 153.0 | **4/6** | **0/6** |

The old column reproducing 4/6 on Chromium is what makes the new one worth reading: the
harness sees the defect it claims to have removed, and Firefox turned out to leak identically
— never measured before, because the original observation came from the bench page's own
exports. The worker now ends itself with `self.close()` after its cleanup, so nothing races
it. **Posting the result after the cleanup was rejected**, though it is what `mem:follow-ups`
prescribed: it makes page start-up wait on an OPFS removal that can hang, for an answer
already known. The sweep still owns the name regardless.

### `.wa-sqlite` — residue that predates the recording mechanism

`OPFSWriteAheadVFS`'s `LIBRARY_FILES_ROOT`, seen at the start of runs on macOS Chrome
(2026-09-04 00:14) and macOS Safari (00:17, 00:19), surviving both runs of each pair. It
carries neither the `bench-` prefix nor a VFS class name, and `layout: 'opfs-path'` does not
tell it from three other VFS. Left in place **by design** — it predates the claim mechanism,
so it reads as pre-existing and the "never touch what was already there" rule protects it.
Clearing it is a manual act on that profile. It cost the runs nothing: 146 `pass` with it
present.

## HANDLE-1 measured per VFS — 2026-09-04, four platforms, `preview` on Pages

**Method.** The bench page's `reads-during-long-query` row, which races a short read against
a long statement holding one of the pool's workers: the read winning means it was served
without waiting. No clock, no threshold. Ten exports across four platforms, `poolFor` = 4 for
every VFS below, so "no other worker" is excluded.

| engine | served | waited |
|---|---|---|
| Chromium 150 (has `readwrite-unsafe`) | Adaptive, WriteAhead, AnyContext | CoopSync, IDBBatchAtomic |
| Safari 27 (no RWU, macOS + iPadOS) | AnyContext/jspi only | everything else |
| Firefox 154 (accepts RWU, ignores it) | AnyContext only | everything else |

**Corrected 2026-09-14 — two cells of this table are not what they say.** IDBBatchAtomic's
"waited" is the **unsignalled** path: the row passes a `signal`, which reached the worker only from
`f4b3fd7`, after these exports, and at `29fbc71` the same row reports it served (IDB-SIGNAL,
above). WriteAhead's "waited" off Chromium ran on **one live worker**, the other three lost
(WORKER-LOST, above). The one-handle OPFS columns were not re-measured under a yielding statement:
since `29fbc71` the row skips a column whose pool runs one worker.

**The partition follows `readwrite-unsafe` exactly** — the README's central limitation, until
now stated in prose and inferred from `read-burst` ratios. The read-burst gains agree
independently: 0.89-1.45 across twenty non-AnyContext columns on Safari and Firefox.

**`OPFSAnyContextVFS` is the only OPFS VFS serving concurrent reads without RWU**, which makes
it the one to suggest to a Safari or Firefox consumer who reads while working. It is also the
worst writer measured here — 13-18 ms for a single INSERT against 0.2-0.6 ms, and 695-821 ms
on the 500-UPDATE row against 32-125 — so it is a trade, never a winner.

### `OPFSWriteAheadVFS` beats the default on Safari on every axis but concurrency

macOS Safari 27, 2026-09-04, `sync` against the default `OPFSAdaptiveVFS/async`. **n=1.**

| | default | WriteAhead/sync |
|---|---|---|
| write p50 | 2.00 ms | 0.60 |
| write **p95** | 8.60 ms | **1.00** |
| point read | 1.90 ms | 0.20 |
| page of a list | 4.60 ms | 2.00 |
| full scan | 16 ms | 10 |
| transaction | 44 ms | 31 |

This is what refuted `mem:vfs`'s "outside Chromium it earns nothing over the default", which
had been generalised from a read-burst measurement about concurrency alone.

### What the grouping recovered

`point-read` was nulling 61 cells of 88 on iPadOS before being timed in groups of 20;
`write-latency` 14 of 22 on both Safaris and 18 of 22 on Firefox, `list-page` 10 of 22 on
Firefox, before groups of 5. The cause was always the clock — 0.1 ms on Chromium, 1 ms on
Safari and Firefox — never the dataset.

After, and it is not uniform:

- **Chromium and both Safaris: clean.** One null cell in a whole 22-column export, and it is
  `reads-during-long-query` failing its 1.5-3 s calibration — the row declining to answer
  rather than guessing. iPadOS shows one to three of those, `/async` builds only.
- **Firefox 154 still nulls 8 of 22 on `write-latency-p50`** and 3 on the p95, on the
  fastest columns: `AccessHandlePoolVFS` and the two memory VFS run at 0.1-0.4 ms per
  insert, so even ×5 stays under the 2 ms floor a 1 ms clock imposes. Predicted before the
  device run and confirmed by it. Raising the group would fix it and cost p95 sensitivity —
  the reason five was chosen — so it stands as a known gap, not an oversight.

### A tab on the origin blocks two columns, reproducibly

macOS Safari, 2026-09-04: `sweep.left: ["idb:IDBBatchAtomicVFS (blocked)"]` with
`idbAfter: ["IDBBatchAtomicVFS"]` — so not a slow delete, a live connection elsewhere. Both
`IDBBatchAtomicVFS` columns then failed `opens` at 20 s. The chain: another connection →
`deleteDatabase` fires `blocked` → **the delete request stays queued on that database** → the
run's own open queues behind it. **`/` and `/preview/` are the same origin**, so a tab on the
released page holds the same stores. Quitting Safari cleared it and the next run was clean,
22 columns, zero failures. Before 2026-09-04 `blocked` was counted as a successful deletion,
so this was silent rather than absent.

## CACHE-BYTES settled — 2026-09-03, Chromium / Firefox, this container

**Method.** Throwaway `tests/browser/cache-bytes-probe.test.ts` (deleted). N concurrent
`bulkWrite`s at `poolSize: 1`, each on its own table, counting statement COMPILATIONS across
every INSERT batch — never a duration, per `mem:lessons`. Fresh database per arm
(`createTestClient` mints a UUID name); budgets walked ascending in one pass and DESCENDING in
the other, so position cannot pass for effect. The floor is 2 compilations per writer: one
full template plus one partial.

**Both engines returned byte-for-byte identical numbers.** Chromium and Firefox, every cell.
That is itself the finding: the bound is a function of SQLite's statement memory, not of the
engine.

5 columns, 15 000 rows per writer (~2.4 MB per full template):

| writers | floor | 4 MB | 8 MB | 16 MB |
|---|---|---|---|---|
| 2 | 4 | 4 | 4 | 4 |
| 3 | 6 | **9** | 6 | 6 |
| 4 | 8 | **12** | 8 | 8 |
| 5 | 10 | **15** | **15** | 10 |

1 column, 70 000 rows per writer — the WORST case, since `bulkWrite` flushes every
`floor(32766 / columns)` rows and `mem:measurements` puts the template ceiling at 3.4 MB on the
narrowest table:

| writers | floor | 8 MB | 16 MB |
|---|---|---|---|
| 3 | 6 | 6 | 6 |
| 4 | 8 | **12** | 8 |

**The derivation was right, and it is now run rather than deduced.** `B > (N − 1) × MAX`
predicts the break at every cell: at 2.4 MB templates 8 MB holds four writers and fails at
five (needs > 9.6 MB); at 3.4 MB templates it holds three and fails at four (needs > 10.2 MB).
Every prediction landed.

**What the 8 MB default actually buys, in one sentence:** four concurrent `bulkWrite`s on a
typical table, or three on the narrowest. Above that the cache is **cancelled, not degraded** —
the count jumps straight to one compilation per batch (3N), which is the shape §3.1 of the
byte-bound spec described and nobody had seen.

## The eviction churn, priced — 2026-09-03, both engines

**Method.** Throwaway `tests/browser/churn-probe.test.ts` (deleted). The sharp protocol:
cycling K DISTINCT statements through the 32-entry LRU flips regime at K = 33, because the
entry each call needs is the one the previous call evicted. One extra statement inverts the
cache completely, so the delta is the churn and nothing else. 2000 reads per arm, n=3, arms
alternated forward / reversed / forward.

| arm | compilations | Chromium mean | Firefox mean |
|---|---|---|---|
| parameterised, 1 statement | **0 / 40** | 2306 ms | 1649 ms |
| 32 distinct — fits | **0 / 40** | 2306 ms | 1646 ms |
| 33 distinct — thrashes | **40 / 40** | 2437 ms | 1816 ms |

**The counts are the finding; the durations are indicative.** 0 out of 40 against 40 out of
40 is the whole mechanism, decisive on both engines. The time cost is ~6 % on Chromium and
~8-10 % on Firefox — about 0.07-0.09 ms on a ~1 ms read, which is sub-millisecond and
therefore exactly where `mem:lessons` says to count instead of time. A second Chromium timing
pass was noisy enough that its `fits` arm read slower than its `parameterised` arm, which
cannot be true; treat the percentage as an order of magnitude, not a measurement.

**And the cache costs NOTHING when it fits.** Parameterised and 32-distinct are
indistinguishable on both engines — holding 32 entries is not measurably worse than holding
one. The churn is entirely the recompilation, not the bookkeeping.

**Counting needed its own short pass.** `db.debug`'s histories are bounded at 50 requests per
worker and 50 queries per request, so totals taken across a 2000-query loop come back
NEGATIVE — the history shifts out from under them. The counts above are from a separate
40-query arm where the history is intact. Anyone reading `prepared` over a long loop will hit
this.

## The write designation DOES migrate — 2026-09-03, both engines, identical

**Method.** Throwaway `tests/browser/writer-migration-probe.test.ts` (deleted). `poolSize: 4`,
counting the distinct worker indices that served an INSERT batch.

| arm | workers that wrote |
|---|---|
| one `bulkWrite`, quiet pool | `[0]` |
| one `bulkWrite`, 3 readers looping throughout | **`[0, 3]`** |
| two `bulkWrite`s, 3 readers looping throughout | `[0, 3]` |

**This corrects the claim this file used to carry.** "All 32 INSERT batches landed on worker 0,
which is why 8 MB per worker is not 32 MB in practice" was measured on a quiet pool, and is
true only there. Under read pressure the designation moves and a second worker accumulates
heavy templates: the real ceiling at `poolSize: 4` is **2 × 8 MB, not 8 and not 32**. It did
not spread further at two concurrent writers, on either engine.

## The gate's cost is linear in `poolSize` — 2026-09-03, both engines

**Method.** Throwaway `tests/browser/gate-cost-probe.test.ts` (deleted). Client creation to the
FIRST query resolving — the open alone, not a read burst on top. n=3 per size, passes
alternating ascending / descending / ascending.

| `poolSize` | Chromium (ms) | Firefox (ms) |
|---|---|---|
| 1 | 84 / 73 / 71 — mean **76** | 77 / 64 / 62 — mean **68** |
| 2 | 95 / 72 / 75 — mean **81** | 90 / 84 / 77 — mean **84** |
| 4 | 98 / 87 / 93 — mean **93** | 124 / 121 / 132 — mean **126** |
| 8 | 131 / 122 / 120 — mean **124** | 208 / 204 / 201 — mean **204** |

**Linear, no cliff, and the constant is the engine's:** ~7 ms per extra worker on Chromium,
~20 ms on Firefox — Firefox pays about three times as much. This settles GATE-1's second
bullet: the shape above 4 is the same shape, so `bsq:init` serialising the opens costs the sum
and nothing surprising happens at 8. Documented in the README's `poolSize` row, which had no
number at all.

## Handle starvation reproduces deterministically — 2026-09-03

**Method.** Throwaway `tests/browser/starvation-probe.test.ts` (deleted). Client A on
`OPFSAdaptiveVFS`, `poolSize: 1`, holding an OPEN write transaction; client B created on the
same file with `openTimeout: 3000`; timing B's first query.

| engine | outcome |
|---|---|
| Chromium | **opened after 47 ms** |
| Firefox | **`TIMEOUT` after 3077 ms** |

**This is the phenomenon GATE-1 says no test exercises**, and it reproduces on the first
attempt with no timing tricks: the write transaction holds the one rotated exclusive OPFS
handle, and the second client's `open_v2` never gets it. Chromium is unaffected because
`readwrite-unsafe` gives each connection its own handle.

**Why it is not a permanent test yet, and this is a decision rather than a difficulty.** The
result is engine-conditional by nature, and `readwrite-unsafe` is in `UNPROBEABLE`
(`capabilities.ts:37`), so a test cannot branch on it — WebIDL ignores the unknown option and
answering yes is wrong. This repository has **no skip-by-engine idiom**: every browser test is
written to pass on both, and where reduced mode changes the outcome the tests accommodate it
(`long-query.test.ts:61`, `multi-client.test.ts:97`). Adding a Firefox-only test would
introduce a convention this project has never taken, which is the user's call, not a
reviewer's. The alternative is an assertion weak enough to hold on both — "opens, or reports
TIMEOUT; never hangs and never silently shrinks the pool" — which pins the gate's contract
rather than the starvation.

## The readiness gate, measured 2026-08-31 (Chromium 151 / Firefox 153, this container)

Toggled by passing `poolSize: 0` to `createScheduler`, which leaves the gate open
from the start. Everything else unchanged.

**What the gate prevents, and it is not what was inferred.** `poolSize: 4`, a
`CREATE TABLE` and a 4 000-row `bulkWrite` issued immediately after client
creation, then a 40-read burst. Counting workers that ever reported
`initializationTime`:

| | gate on | gate off |
|---|---|---|
| Firefox | 4w · 4w · 4w | **1w · 1w** · 4w |
| Chromium | 4w · 4w · 4w | 4w · 4w · 4w |

Two runs in three, the early write seizes the one exclusive handle and the other
three workers never open — for the life of the client. No eviction, no log, no
`openTimeout`: the pool is simply a quarter of what was asked for. Chromium holds
one handle per connection and is unaffected.

**What the gate costs.** Same shape, timing from client creation to a 40-read
burst completing, `poolSize: 4`: 147/159/161 ms with the gate against 140/130/153
without on Chromium, 196/175/191 against 176/179/143 on Firefox. About 15 ms,
both engines — the serialised opens, nothing more.

**Where the effect is NOT.** Timing the same read burst *after* a warm-up query,
so the opens fall outside the measurement: 28/28/26 against 34/29/30 on Chromium,
78/65/69 against 71/65/68 on Firefox. Indistinguishable. Forty small
`sqlite_master` reads do not care whether they run on one worker or four, which
is why this probe confirms the mechanism and says nothing about magnitude.

## `no-read-inside-transaction` per VFS, 2026-08-31 — deterministic at n=3

Invariant 6's race, run three times per engine in this container. No flip, in
either direction, on either engine.

| VFS | Chromium ×3 | Firefox ×3 |
|---|---|---|
| `OPFSAdaptiveVFS` | pass | blocked |
| `OPFSWriteAheadVFS` | pass | blocked |
| `OPFSCoopSyncVFS` | **blocked** | **blocked** |
| `IDBBatchAtomicVFS` | pass | pass |
| `OPFSAnyContextVFS` | pass | pass |

`OPFSCoopSyncVFS` blocked on both, which is what the README's Known Limitations
entry claims — defensible at n=3 per engine now. The other two OPFS VFS blocked
on Firefox only: the reduced-mode signature, not a property of those VFS.
**The WebKit flip is NOT covered here** — Linux WebKit exposes no
`navigator.storage`, so the platform where the 2026-08-27 campaign saw it cannot
be reached from this container at all; it needs the user's Apple hardware, whose
Safari has moved to 26.6.2 since, making that campaign a stale baseline rather
than a comparison. It gates no published sentence, so nothing is owed on it —
this table is where it is recorded, and there is no backlog entry.

## Performance backlog closed — 2026-08-31, this container, Chromium 151 / Firefox 153

Scratch harness `tests/browser/perf-probe.test.ts` (deleted). Numbers left the page
through thrown assertion messages: `browserLogs: false` in `rstest.config.ts` means
`console` is not forwarded. `navigator.hardwareConcurrency` 16 on both engines.

### The per-row object build — why the loop replaced `Object.fromEntries`

Isolated microbenchmark, both variants **alternating inside one page** so drift lands on
both sides, 5 rounds, 50 000 rows x 12 columns. Ranges are tight; this is the one
deterministic measurement of the campaign.

| | `Object.fromEntries(cols.map(...))` | hoisted loop | saved |
|---|---|---|---|
| Chromium | 17.5 ms (17.3-18.0) | **4.4 ms** (4.3-4.4) | 13.1 ms |
| Firefox | 23.0 ms (23.0-24.0) | **14.0 ms** (14.0-16.0) | 9.0 ms |

End to end, the same read through the client at `poolSize: 1`, medians of 5 after a
discarded warm-up: Chromium 183 -> 160 ms, Firefox 631 -> 619 ms. **The end-to-end A/B is
noise-dominated** (Firefox's narrow-row control moved further than its wide-row case,
which is impossible if the effect were real at that size) — it corroborates the direction
on Chromium and settles nothing on Firefox. The microbenchmark is the measurement; the
end-to-end figure is what fraction of a read it represents, ~7 % on Chromium and ~1.4 %
on Firefox.

### Sharing one compiled `WebAssembly.Module` across the pool — measured, then dropped

`wa-sqlite-async.wasm` is 1 233 KiB. The mechanism works: `structuredClone` of a compiled
module costs 0.00-0.10 ms and the clone arrives as a usable `WebAssembly.Module`
(273 exports read in the receiving worker).

**A fresh worker, handed the bytes against handed the module**, 5 rounds, blob workers so
no bundler is involved:

| | compile bytes, in worker | receive Module, in worker | round trip delta |
|---|---|---|---|
| Chromium | 3.3 ms | **0.0 ms** | 3.9 ms |
| Firefox | 19.0 ms | **0.0 ms** | 19.0 ms |

**What kills it on Chromium and keeps it alive on Firefox is whether those compiles
overlap.** N fresh workers each compiling the same bytes, wall clock to the last reply:

| workers | Chromium | Firefox |
|---|---|---|
| 1 | 6.0 ms | 29 ms |
| 2 | 5.9 ms | 37 ms |
| 4 | 8.1 ms | 68 ms |

Chromium is flat — the compiles are parallel and sharing the module buys ~2 ms at
`poolSize: 4`. **Firefox scales almost linearly**, so it does not overlap them: sharing
would take `poolSize: 4` from ~68 ms to ~29 ms, about **39 ms**, and the default
`poolSize: 2` from 37 to 29 ms, about **8 ms**. Against a first query measured at
175-196 ms on Firefox.

`performance.measureUserAgentSpecificMemory()` is **undefined** in this harness —
`crossOriginIsolated` is false on both engines — so the code-memory side, the reason the
entry survived this long, could not be measured at all.

Two shapes exist and only one is cheap. Having the client fetch and compile moves wasm URL
resolution out of the worker bundle, which is the exact fragility the five-bundler smoke
exists to catch, and `resolveWasmLocation` yields a URL only when the consumer overrode
`wasmUrl`. Having worker 0 relay its module to the others keeps resolution where it is and
loses nothing, since Firefox serialises those compiles anyway. **Dropped on the numbers,
not on the difficulty:** nothing on Chromium, 8 ms at the default `poolSize` on Firefox,
and a handshake added to the open path — the path GATE-1 and three abort defects were paid
for. Reviving it needs no new measurement, only this table.

## The dropped chunk — 2026-09-04, Chromium 151 / Firefox 153, this container

The defect: the pool's transport held ONE slot for an in-flight chunk while the credit
window puts `credits` of them in flight. A chunk arriving while the generator was suspended
at its `yield` resolved a promise nobody would ever await. Fixed by `3ef05cb`.

**The law, from varying the credit window on one query** (1001 rows, `MemoryVFS`, consumer
sleeping 50 ms per chunk). The consumer received only the chunks that arrived while it was
waiting:

| credits | delivered |
|---|---|
| 1 | 3 chunks, **1001 rows** |
| 2 (default) | 2 chunks, **501 rows** |
| 4 | 1 chunk, **500 rows** |

**Per surface, five runs each, both engines, zero variance:**

| surface | before | after |
|---|---|---|
| `chunk()` consumed without pausing | 1001 | 1001 |
| `chunk()` with a 50 ms pause | **501** | 1001 |
| `stream()` with `await setTimeout(0)` per row | **501** | 1001 |
| `read()` | 1001 | 1001 |
| `first()` | 1 | 1 |
| `write(… RETURNING)` | 1001 | 1001 |

The `setTimeout(0)` row is the one to quote: one turn of the event loop was the entire
precondition, not slow work.

**Present in the published release.** A worktree of the `v1.0.0-rc.4` tag, same probe, same
numbers — 1001 without a pause, 501 with. rc.3 carries the same three lines in `client.ts`,
before `pool.ts` was extracted. Probes: `.scratchpad/chunk-drop/` (throwaway).

**A second measurement came out of the fix itself**, and is the reason the delivery loop
consults its failure channels through flags: a loop that always has a queued chunk never
awaits, so a `messageerror` raised mid-stream went unreported for the whole remaining query
before the flag existed. Found by a test written for a different property.

## Query interruption — 2026-09-04/05, Chromium 151 / Firefox 153, this container

Full tables and their method are in the design,
`docs/superpowers/specs/2026-09-04-query-interruption-design.md` §4.3 — it is the only place
they are written out, and it was written from these runs. What follows is what a later
session needs without opening it. Probes: `.scratchpad/interrupt-1/` (throwaway).

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

## The `sync` build against the `async` build — 2026-09-07, read off `.bench/`

**Not a new campaign: a reading of exports already in the repository.** Three files, all
labelled `preview @ 45e67fa` — a commit that is on `main`, so this is near-current code and
NOT released rc.4, whatever the `lib` field says. `20260904124315-macos-chrome-150`,
`20260904135152-macos-safari-27.0`, `20260904152056-macos-firefox-154.0`. **n=1 per cell**:
a bench export is one run. iPadOS Safari 27.0 (`20260904124014`) carries the same build and
is used for the per-platform reading below.

**Read the units before the names.** `full-scan`, `list-page-p50`, `transaction-throughput`
and `overwrite-throughput` all declare `unit: 'ms'` in `scripts/bench/html/index.html`
despite what two of those names suggest — **lower is better on every one of them**. Only
`read-burst-concurrency` is `better: 'high'`.

**Same VFS, both builds — the ratio async ÷ sync.** Four VFS declare `['sync','async','jspi']`
and so can be compared against themselves: `OPFSWriteAheadVFS`, `OPFSCoopSyncVFS`,
`AccessHandlePoolVFS`, `MemoryVFS`.

| metric | Chrome 150 | Safari 27 | Firefox 154 |
|---|---|---|---|
| `full-scan` | 1.58–2.16× | 1.50× on all four | 2.29–2.67× |
| `list-page-p50` | 1.65–2.41× | 1.60–1.70× | 2.33–3.20× |
| `bulk-insert-dataset` | 1.16–1.43× | 1.25–1.32× | 1.17–1.35× |
| `point-read-p50`, `write-latency-p50` | ~1.00× | 1.00–1.63× | ~1.00× |

Twelve cells, three engines, all in the same direction. **No `async` cell is faster than any
`sync` cell on `full-scan`, on any of the three engines** — on Firefox the sync cells sit at
6–7 ms while every async cell, all VFS included, sits at 15–16 ms.

**The async build buys interruptibility and nothing else.** `read-burst-concurrency` is
unchanged between the two builds of the same VFS (`OPFSWriteAheadVFS` on Chromium: 2.91 sync
against 3.10 async, inside the noise at n=1), and `reads-during-long-query` does not move —
`false` stays `false` on `OPFSWriteAheadVFS` and `OPFSCoopSyncVFS`.

**What this does NOT license.** The page measures one client's throughput on one dataset. It
says nothing about open time, cross-tab behaviour, or the Safari hazards that the VFS
recommendation partly rests on. The interruption lot merged the day after these exports were
taken; its progress handler is installed only when a `signal` or `timeout` is passed, which
these rows do not pass, so the ratios are expected to hold — **expected, not re-measured**.

The README cites this reading in `Known Limitations` → `Aborting a call`, deliberately
without figures: "may take significantly longer, on the order of twice as long in this
project's own measurements and more than that on some engines".

## `deleteDatabase` hangs — the whole corpus, split by era, 2026-09-07

**This supersedes the "six deletion timeouts sit on two VFS" reading above**, which was one
campaign on one build. Every export in `.bench/` carries a `deleted-is-gone` row per
`(vfs, build)` pair in its `conformance` block — **86 files, 1 225 pair-rows**. Counted, not
sampled.

**The corpus must be split at 2026-09-02, and a first reading that did not split it was
wrong.** `src/delete.ts` was rewritten that day — `refuse to delete a database a client still
holds`, `report a database that is not there`, `correct INVALID_OPTION message` — on top of
`key lock names on the storage namespace, not the VFS` the day before. Exports before that
date exercise a different deletion path. The user caught this; the un-split table had been
committed and had to be corrected.

**Every timeout in the corpus is pre-rewrite. There is not one after it.**

| era | files | `OPFSWriteAheadVFS` timeouts |
|---|---|---|
| before 2026-09-02 | 50 | Firefox 154 **7/24** (3 `async`, 2 `jspi`, 2 `sync`), macOS Safari 26.5.2 **3/4**, iPadOS 27.0 **2/5** (`jspi`), iOS 26.6 **1/5** |
| 2026-09-02 onwards | 36 | **none, on any engine** — Firefox 15 runs over three builds, Chromium 24, macOS Safari 27.0 24, iPadOS 33, macOS Safari 26.6.2 6, iOS 26.6.1 2 |

`OPFSCoopSyncVFS` shows the same shape and the same split: 1/8 Firefox `async` and 1/12 macOS
Safari 27.0 `async`, both pre-rewrite, nothing after. `OPFSAdaptiveVFS` never hung in either
era.

**What the post-rewrite runs are worth.** Firefox is the arm that carries the weight: the
pre-rate there was ~29 %, so 15 consecutive clean runs is not a small sample against it. The
gap is **macOS Safari 26.5.2**, which produced 3 hangs in 4 and has not been re-run since —
the 26.x device in the post-rewrite set is 26.6.2.

**CLOSED 2026-09-07, on a mechanism and not only on absence.** `DELETE-TIMEOUT-1` was deleted
from `mem:follow-ups` the same day. `8a5a649` says in its own message that the surviving VFS
"survived by accident, on OPFS handle exclusivity this library never arranged" — HANDLE-1 — and
replaces that with a non-queuing acquisition carrying the comment *"A request that never queues
cannot deadlock"*. The same commit adds a `setTimeout(0)` before returning, because the Web
Locks API releases a lock by queuing a global task, so an immediate return made a freed lock
look held — and it notes **Chromium does not require this**, which matches Firefox being the
worst arm by far. The user closed it on 2026-09-07 with the argument that macOS users track
patch releases, so a caveat about a superseded 26.5.2 buys a consumer nothing; two further runs
on 26.6 were offered and declined as uninformative — that arm never failed. The fix is recorded
for consumers in `CHANGELOG.md` under Fixed, because **rc.4 is published with the old path**.

**The `readwrite-unsafe` attribution is now doubly unsupported.** It was already only a
correlation — the mode is Chrome/Android 121+ and `null` everywhere else, so "Chromium" and
"has the mode" name the same engines in every export we hold. And the era split says the
defect tracked OUR deletion path, not the engine's handle mode. **A Chrome 120 campaign was
proposed to separate the two on 2026-09-07 and is no longer worth running for this purpose**:
it would be testing an engine hypothesis for a defect the evidence attributes to a library
path that has since changed.

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

## HANDLE-ORPHAN — Firefox DOES release a terminated worker's sync handle, 2026-09-09

**This measurement contradicts the explanation HANDLE-2 carried until today**, which said
Firefox does not release the handle. At the ENGINE level it does. See `mem:vfs`, HANDLE-2,
which was corrected the same day.

Raw OPFS only — no wa-sqlite, no VFS, no client. A blob-URL worker creates a
`FileSystemSyncAccessHandle` on a fresh OPFS file, writes four bytes, flushes, reports, and is
then `terminate()`d by the page. A second worker polls `createSyncAccessHandle()` on the same
file every 100 ms for up to 10 s. Run twice: unloaded, and under the sixteen busy-loop workers
ABANDON-WEDGE validated as the load that makes the real defect reproducible. Firefox, this
container.

| probe | unloaded | under 16 busy loops |
|---|---|---|
| control — holder closed the handle, then killed | opens, 1 attempt, 1 ms | opens, 1 attempt, 6 ms |
| holder killed while **idle**, holding | opens, 1 attempt, 1 ms | opens, 1 attempt, **2 ms** |
| holder killed while **spinning**, holding | opens, 1 attempt, 1 ms | opens, 1 attempt, **5 ms** |
| `removeEntry()` issued immediately after the kill | `removed` | **`NoModificationAllowedError`** |
| `getFile()` read after the kill | — | 4 bytes, intact |

**A worker killed mid-synchronous-loop releases its handle exactly like an idle one** — which
is the case that mattered, since the real holder is inside `sqlite3_step()` and cannot answer
anything.

**The release is prompt but NOT instantaneous, and that is the whole nuance.** The
`removeEntry` row is the same operation as the others except that it runs microseconds after
`terminate()` rather than after a worker spawn: under load it still meets
`NoModificationAllowedError` — the very name ABANDON-WEDGE captured once. So that error names a
window of a few milliseconds, not a stable state.

**What it does not cover.** The probe's holder is a plain worker holding a raw handle. The real
holder also owns wa-sqlite's `ahp:<path>` Web Lock and a `retryOps` state machine, and its peers
carry their own. This measures the engine and nothing above it — which is what it was for: the
engine is exonerated, so HANDLE-2's permanence lives in the hand-over protocol or in our pool.

Probes: `.scratchpad/handle-2/` (throwaway), with a README mapping each to what it answered.

Method note: the browser console is not forwarded by the rstest reporter, so the probe carried
its values out through deliberate assertion failures. Anything measured this way must collect
its results and emit them ONCE per test — the first failing `expect` ends the test, which cost
one run's worth of P4.

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

## HANDLE-2 does not reproduce — 2026-09-09, ~70 attempts on `main`, 40 at the pre-fix commit

Written because a negative that cost this much must not be re-paid. See `mem:vfs`, HANDLE-2.
Probes: `.scratchpad/handle-2/` (throwaway) — the six shapes below are the files there, and
its README says which answered what. The pre-fix runs used a git worktree at `94bfaac` with
`node_modules` symlinked from the main checkout, which is enough to run one browser config.

On `main`, six shapes, Firefox, `OPFSCoopSyncVFS`, under sixteen busy loops, all with the OPFS
resource and the lock table checked at the moment of interest: holder killed while idle; holder
killed mid-`step()`; crash through `handleDeath` with a second client contending for the handle
(10); crash inside an open transaction (16 across four forms); an abandoned generator with a
`next()` outstanding, `drainTimeout` lowered (10). **No wedge attributable to the handle in any
of them**, and every recovery path behaved: the `ahp:` lock is released on termination, a raw
third-party `createSyncAccessHandle()` succeeds, a replacement worker spawns and serves.

At the pre-fix commit `94bfaac`, where ABANDON-WEDGE recorded **9/40 (22 %)** on
`OPFSCoopSyncVFS`: `abandon-transaction.test.ts` forced onto that VFS and run 20 times under
sixteen SHELL busy loops, 12 times under sixteen IN-PAGE busy loops, plus 8 runs on the default
VFS — **0/40**. At 22 % a null of 0/20 alone has probability 0.6 %.

**What this does and does not license.** It does not prove the original observation was invented
— the load profile of a container hours apart is not controllable, and the recorded run had the
full `pnpm test` chain around it, which none of these did. It does mean **nobody has a
reproduction of HANDLE-2 today, on `main` or before the fix**, and that the only symptom anyone
has described — a permanent, silent, origin-wide wedge — is produced deterministically by
WRITELOCK-STUCK above, whose shape the pre-fix branch is independently recorded as having hit
(`mem:history`: "an `await gen.return()` parked behind an in-flight `next()` that held the
origin's write lock indefinitely").
