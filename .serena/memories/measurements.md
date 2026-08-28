# Measurements — every number, with its date and method

**Rules for this file.** A number enters only with a date, a method and the machine it was
taken on. Correct an entry in place when it is re-measured; do not append a contradicting
one. A number nobody can reproduce is a story, not a measurement — say so in the entry.

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
of the nine VFS**, `OPFSAdaptiveVFS` included: that is the reduced-mode signature FLAKE-ROW-1
describes, not a property of this VFS.

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
  FLAKE-ROW-1's n≥3 rule keeps earning itself.

**What the three rounds taught, and it is not "run more":** two conclusions were written
from one run per device and both were wrong, in opposite directions. The first said a flake
was a defect. The second said a defect was not residue — resting on a manual clearing whose
effect was never verified. **A manual step you did not observe is not evidence**; the page
could have reported whether the OPFS root was empty, and nobody asked it.

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
Compile count: cache=0 → every execution (50/50 visible); cache=32 → 0/50 visible (warm
after first). Savings are 1 compilation per run of 2 000.

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
