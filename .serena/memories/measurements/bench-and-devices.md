# Measurements — the bench page, devices, browsers, bundlers

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## IDB-SIGNAL — a signal lets `IDBBatchAtomicVFS` serve a read during a long query, 2026-09-14, this container

**The discrepancy.** The bench's `reads-during-long-query` reported `IDBBatchAtomicVFS/async`
`false` in every export from 2026-09-04 to 2026-09-08 — previews `2700426`, `45e67fa`, `0b63bf3`;
Chromium 150, Firefox 154, Safari macOS/iPadOS/iOS, Chrome Android — and `true` in every export at
`main@29fbc71`: Firefox 153 ×3 and Chromium 151 ×1, this container, `poolSize` 4. Not the
calibration (Chromium: 971 iterations against 953-979 on 2026-09-04), not the row (its body is
unchanged since 2026-09-04).

**The probe** — throwaway, current `main`, pool 4, 4 000
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

**The yield costs nothing measurable.** A throwaway probe,
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
user's console probe on preview `4340da6`**:
a read issued 50 ms into an unsignalled self-join won 3/3, 2-3 ms against 343-355 ms. The worker
tick costs 0.05 ms there (0.002-0.005 on Chromium and Firefox), and a signal adds nothing
measurable to MemoryAsyncVFS (19-21 against 20-22 ms). Before a Safari restart the same probe
could not open `IDBBatchAtomicVFS` at all — `create` and `deleteDatabase` hung past 20 s — in a
tab where an earlier probe had left a client stuck: the blocked-origin case ("A tab on the origin
blocks two columns", below), not the fix.

**The bench's `null` on Safari, traced — an intermittent stall, not the fix.** Console probes on
the user's Safari 26.6.2:
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
  run, `reasons` empty. Its label reads `a85c273`: the
  page was built before `5052d4f` was committed, from the same tree.
- **It is the `async` build, not IndexedDB and not the library** (v10, `localhost:8099`, same
  Safari, pool 1, after the same writes, no signal anywhere, so no yield from us). Four ~1.5 s long
  reads, then a full scan before → after them:

  | VFS / build | long reads, ms | scan before → after, ms |
  |---|---|---|
  | MemoryVFS `sync` | 1 477 / 1 463 / 1 433 / 1 458 | 5 → 5 |
  | MemoryAsyncVFS `async` | 1 575 / 1 585 / 1 575 / 1 580 | 8 → 76 |
  | OPFSAnyContextVFS `async` | 1 363 / 1 389 / 1 363 / **29 684** | 10 → 175 |
  | IDBBatchAtomicVFS `async` | 1 327 / 1 352 / 1 348 / **11 191** | 9 → 119 |

  The `sync` build is untouched; every Asyncify build degrades and stays degraded, worst where
  the VFS does real asynchronous I/O inside the statement. Chromium ran the same probe flat. A guess,
  not a finding: JavaScriptCore moving the Asyncify module to a slower tier or bounds-checking mode.
  Untested: the `jspi` build, which has no Asyncify — Safari 27 has JSPI, 26.6 does not.
- **`jspi` escapes it — Safari 27.0 macOS, the user's second Mac, preview `5052d4f`** (v11,
  same shape, pool 1):

  | VFS / build | long reads, ms | scan before → after, ms |
  |---|---|---|
  | IDBBatchAtomicVFS `async` | 1 264 / 1 283 / 1 281 / **2 394** | 13 → 179 / **95** |
  | IDBBatchAtomicVFS `jspi` | 1 327 / 1 328 / 1 321 / 1 310 | 8 → 80 / **8** |
  | OPFSAnyContextVFS `async` | 1 238 / 1 240 / 1 240 / 1 241 | 14 → 310 / **92** |
  | OPFSAnyContextVFS `jspi` | 1 307 / 1 311 / 1 308 / 1 307 | 9 → 200 / **11** |
  | MemoryVFS `sync` | 1 587 / 1 567 / 1 570 / 1 569 | 7 → 7 |

  Milder than on 26.6.2, same shape: the `async` builds stay slow afterwards, the `jspi` builds'
  second scan is back at baseline — as on Chromium, whose first scan after long reads is also slow
  once. **The bench on that Safari 27**:
  `reads-during-long-query` **true** on IDBBatchAtomicVFS/jspi (200 → 587, 681 → 1 612 ms) and
  OPFSAnyContextVFS/jspi (200 → 579, 691 → 1 619 ms); **null** on both `async` columns, whose
  per-unit cost climbed during the calibration itself — IDB 200 → 631, 634 → 4 425, verified 317 →
  14 538 ms; AnyContext 200 → 8 430, verified 100 → 4 128 ms. The earlier rows had already set the
  slowdown off. The `null` is honest there: that build cannot hold a statement's cost steady.
- **Safari only.** The same v10 on Firefox 153, this container: four long reads per column at
  1 520-1 608 ms on all four VFS/builds, and a full scan after them 149-157 ms once on the two I/O
  VFS, back to 57-58 ms on the second — Chromium's shape. MemoryVFS `sync` 41 → 43 ms.

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
`window.__SMOKE__`. A build that emits is not a pass; the page must read rows back.

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

## Safari campaign — 2026-08-27, real devices, `feat/safari-device-campaign` on Pages

Four bench exports: iOS Safari 26.6, macOS Safari 26.5.2, macOS Safari 27.0,
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

## VFS-MEDIAN — what settled the recommendation, 2026-09-08, n≥3 per cell

**Method, and the two traps it had to avoid.** Medians per `(vfs, build)` per platform over
the bench exports of the CURRENT metric schema, computed by two throwaway scripts
over the bench corpus.

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

## REOPEN-1 does not reproduce — device campaign, 2026-09-03 (user's hardware)

**Method.** Seven bench exports, taken from the published `/preview/` page — rc.5 code,
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
(2026-09-03).

### The unsafe-handle probe leaked its own file, on both engines — closed 2026-09-04

`__probe_unsafe_handles` outlived the probe worker's `finally`: the main thread called
`worker.terminate()` on the probe's message while the cleanup was still awaiting
`getDirectory()`. **4 of 6 Chromium loads left the file behind**, and a macOS Safari 26.6.2
export carried it into `opfsRootAtStart`. One observation per engine had read as a WebKit
quirk — n=1 again.

**The fix was measured against the defect, not asserted.** A throwaway harness ran the old
and the new probe side by side, six fresh contexts each, Playwright, this container:

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
