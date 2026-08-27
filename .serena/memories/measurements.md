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

## Numbers that are one observation, not a measurement

- **Android 145 vs 151 differ by a factor 2.6** on bulk insert, same emulator. Regression
  or noise; a single run cannot say.
- **Chrome Android 109 crashes the bench page before any run starts.** The README claims
  `Android 109+` on four VFS rows and the only observation we hold for that version is a
  crash. The init path is short — the two candidates are the un-timeout'd
  `await probeUnsafeHandles()` and the unbounded `while (t1 === t0)` clock spin. Triage:
  banner after 8 s → the probe; frozen page → the spin.
- **`navigator.storage.estimate().usage` reported 1.42 GB** on an origin whose whole OPFS
  root weighed ~1.6 MB. The IndexedDB `IDBMirrorVFS` store carried the rest. `usage` is
  origin-wide, not OPFS-wide.
