# Measurements — scheduler, barrier, pool and streaming

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## LEASE-QUIESCE — the lease IS held to quiesce after a timeout, 0/40 under load, 2026-09-21, this container

The open question behind the single `GENERATOR_ABANDONED` sighting of 2026-09-14: can the library
hand a query to a worker still inside the previous one? Chased with the ABANDON-WEDGE method —
sixteen busy loops (the machine has 16 cores) around a single-file Firefox run, the load that once
cut time-to-failure twentyfold.

**Shape, recreated deliberately** (run in a detached worktree so
nothing could land on `main`): `firefox · MemoryVFS/sync` outside cross-origin isolation, so a
statement cannot be cut and the worker stays busy for the query's natural length — **22.4 s
unloaded, measured**. Warm the worker and the statement, time a read out at 200 ms, then read again.

**Result: 0 of 40 runs produced the signal, and 0 of 40 failed at all** — every run's follow-up read
came back. That is not merely an absence: on this build the read can only return by waiting out the
statement, so **the lease was held to quiesce in all 40**.

**The detection path is proved, which is what makes the zero worth anything.** A positive control —
two `tx.read()` overlapping inside one transaction, which `src/pool.ts` says reaches the in-flight
guard with no generator anywhere — raises `GENERATOR_ABANDONED`; and inverting its expectation shows
the text `GENERATOR_ABANDONED: Worker 1 already has…` reaching the rstest report, where the
campaign's grep matches it. Two independent channels, since the campaign also counted `failedTests`
per run.

**What is NOT covered, and it is the same caution ABANDON-WEDGE recorded: the reproducing context
may be the full chain.** The 2026-09-14 sighting happened inside a whole `pnpm test`, tens of pages
in parallel; this campaign ran one file under CPU load. The next arm, if anyone chases it, is the
whole Firefox config under load rather than one file. Also worth carrying: `GENERATOR_ABANDONED` is
wider than its name — two overlapping `tx.read()`s and an in-flight `bulkWrite` batch reach the same
guard.

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
**The WebKit flip is NOT covered here** — Playwright 1.62's Linux WebKit, the one
measured then, exposes no `navigator.storage` (1.63 does, in a persistent context:
WA-WEBKIT-SUITE), so the platform where the 2026-08-27 campaign saw it was not
reachable from this container; it needs the user's Apple hardware, whose
Safari has moved to 26.6.2 since, making that campaign a stale baseline rather
than a comparison. It gates no published sentence, so nothing is owed on it —
this table is where it is recorded, and there is no backlog entry.

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
before `pool.ts` was extracted.

**A second measurement came out of the fix itself**, and is the reason the delivery loop
consults its failure channels through flags: a loop that always has a queued chunk never
awaits, so a `messageerror` raised mid-stream went unreported for the whole remaining query
before the flag existed. Found by a test written for a different property.
