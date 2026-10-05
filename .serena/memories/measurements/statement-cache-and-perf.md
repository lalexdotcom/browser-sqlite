# Measurements — statement cache, pragmas, builds, performance

Part of `mem:measurements`, which indexes every entry; its rules apply here.

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

## The `sync` build against the `async` build — 2026-09-07, read off the bench exports

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

## JSPI-SYNC-RELAYS — the `jspi` build makes every synchronous callback pay a suspension on Firefox — 2026-10-04, this container, Chromium 151.0.7922.34 / Firefox 153 (Playwright `firefox-1538`)

Found while pricing the authorizer (TX-CONTROL-GUARD, `mem:measurements/transactions`). **Cause, read from wa-sqlite's source at the pin:** each relay exists twice, `SIG` and `SIG_async`, and the C side already picks one per callback (`CALL_JS`/`VFS_JS`: the `_async` one only when the JS method is an `AsyncFunction` — `FacadeVFS.hasAsyncMethod`, `instanceof AsyncFunction` in `libauthorizer.js`, `libhook.js`, `libprogress.js`, `libfunction.js`). But `src/asyncify_imports.json`, which the Makefile passes to the JSPI build as well, lists BOTH variants, so the glue's `importPattern` wraps the synchronous relays in `WebAssembly.Suspending` too. The wrapping is done in the JS glue (`dist/wa-sqlite-jspi.mjs`), not in the `.wasm`.

**Engine cost** (hand-written wasm, a loop calling one empty import, dedicated worker, median of 7, 3 pages per engine): plain import 0.004 µs on both; `Suspending` import whose function returns at once **2.2-2.4 µs on Firefox**, 0.055-0.06 µs on Chromium; a real suspension 2.7-3.0 µs on Firefox. Firefox charges a `Suspending` import almost a real suspension.

**The fix, measured without rebuilding:** a copy of the glue whose `importPattern` is `/^([a-z]+_async|invoke_.*|__asyncjs__.*)$/` (`.scratchpad/authorizer-cost-2026-10-03/wa-sqlite-jspi-patched.mjs`), same `.wasm`. Same probe as TX-CONTROL-GUARD, µs per statement, median of 3 pages, ranges within a few %:

| Firefox | `async` | `jspi` | `jspi` patched |
|---|---|---|---|
| `MemoryVFS`, one-row `INSERT` | 87.4 | 363.0 | **95.0** |
| `MemoryVFS`, cached `step` | 22.3 | 81.1 | **28.0** |
| `MemoryVFS`, 50-column prepare, authorizer on | 154.8 | 745.6 | **144.5** |
| `OPFSAdaptiveVFS`, one-row `INSERT` (autocommit) | 2 698 | 2 956 | **2 659** |
| `OPFSAdaptiveVFS`, cached `step` | 449 | 445 | 425 |
| `OPFSAdaptiveVFS`, 50-column prepare | 134.3 | 118.8 | 118.5 |

`OPFSAdaptiveVFS` was created with `lockPolicy: 'shared'`, n = 200 per batch, 5 rounds; its `jLock`/`jUnlock`/`jOpen`/`jClose`/`jDelete`/`jAccess` are `async` and stay suspending, `jRead`/`jWrite`/`jSync`/`jFileSize`/`jFileControl` are sync and stop paying. On Chromium nothing moves (jspi 5 546 / patched 5 600 µs per insert, inside the ranges). **The ~10 % that `jspi` lost to `async` on Firefox writes is gone with the patch** — the same size as the bench corpus's Firefox `transaction-throughput` 1.06 and `overwrite-throughput` 1.08 (`jspi / async`, `OPFSAdaptiveVFS`, 8 exports), which the default-build spec of 2026-09-24 read as "equal". Absolute OPFS timings come from Playwright's off-the-record pages (RSTEST-OTR); the ratios are what this entry claims.

**Risk of the change:** a callback or VFS method that is a plain function returning a Promise works on today's `jspi` build (the `Suspending` wrapper tolerates it) and would break — as it already breaks on the `async` build, where the sync relay cannot await. Every VFS this library ships runs on `async` in the matrix (66/66), so none does that. **Measured since (2026-10-05):** the carried glue — wa-sqlite #375's, whose pattern drops every relay and keeps the `_async` ones wrapped through `isAsync` — under `pnpm test` and the full 66-cell matrix, green; and the `async` build rebuilt without the list: no change on either engine (`docs/upstream/2026-10-05-wa-sqlite-375-sync-relays-plain-imports.md`).
