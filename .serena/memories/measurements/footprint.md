# Measurements — memory and disk footprint per VFS, `bulkWrite` release

Part of `mem:measurements`, which indexes every entry; its rules apply here.

## FOOTPRINT-METHOD — how these were taken, 2026-10-06, this container

Throwaway Playwright harness, Chromium 151 (full `channel: 'chromium'`, not the headless shell, which refuses `measureUserAgentSpecificMemory`) and Firefox 153. **Every measurement in a fresh browser on a fresh persistent profile, deleted after** — nothing carries over from one VFS to the next. Page served with COOP/COEP; `dist/` verbatim, its worker behind a shim that imports a hook first. `jspi` build on every VFS, default options (`poolSize` resolved by the library: 2 on Chromium for the multi-connection VFS, 1 elsewhere). Agent variables stripped (`env -u AI_AGENT -u CLAUDECODE`).

Layers, and what each one sees:
- **Process memory — the reference.** PSS from `/proc/<pid>/smaps_rollup` over the browser's process tree (root found by the profile path in its command line), split into the page's process (Chromium `--type=renderer`, Firefox `contentproc`) and the rest. Delta against a sample taken before the client exists. Chromium: `--js-flags=--expose-gc`, `gc()` in the page and each worker before a sample. **Firefox cannot be forced to collect under Playwright** (no `gc()`, `about:memory` refuses to load), so its deltas carry uncollected garbage: differences under ~10 MB between VFS are noise there.
- **`measureUserAgentSpecificMemory`** (Chromium, isolated page, `--enable-blink-features=ForceEagerMeasureMemory` so it answers in ms): live JS per realm. It counts the wasm `Memory` and a VFS's JS-side buffers; it does not see Blink-side memory.
- **Inside the worker** — reachable without touching the library: an `Object.prototype` setter for `_sqlite3_status64` captures the Emscripten Module at its first assignment, one for `cwrap` wraps `sqlite3_open_v2` to read the connection handle, `WebAssembly.instantiate*` wrapped to keep the `Memory`. **`sqlite3_status` returns 0: wa-sqlite is built with `SQLITE_DEFAULT_MEMSTATUS=0`.** `sqlite3_db_status` (`CACHE_USED`, `SCHEMA_USED`, `STMT_USED`) does not depend on it and works.
- **Disk** — `du` on the profile after `close()` and browser exit (Chromium `Default/File System`, `Default/IndexedDB`; Firefox `storage/default/<origin>/`), and from the page an OPFS walk summing `getFile().size` plus an IndexedDB cursor summing value bytes. Logical size: `page_count × page_size`.

Data: 1 KiB rows of hex text, 1 / 10 / 50 MiB inserted by recursive-CTE statements, then two concurrent full scans so every worker of a pool fills its cache. n=3 per cell, both engines, 0 errors in 168 runs.

## FOOTPRINT-REST — memory at rest after a load

Page process, PSS delta, MB, median of 3. Chromium after forced GC, sampled 12 s after the load; Firefox same timing, uncollected.

| VFS | Chromium 1 / 10 / 50 MiB | Firefox 1 / 10 / 50 MiB |
|---|---|---|
| `OPFSCoopSyncVFS` | 24 / 28 / 33 | 27 / 25 / 27 |
| `AccessHandlePoolVFS` | 24 / 28 / 35 | 24 / 29 / 27 |
| `OPFSAdaptiveVFS` | 31 / 36 / 43 | 27 / 26 / 29 |
| `OPFSWriteAheadVFS` | 35 / 40 / 54 | 29 / 29 / 20 |
| `IDBBatchAtomicVFS` | 35 / 44 / 58 | 50 / 62 / 68 |
| `OPFSAnyContextVFS` | 35 / 55 / 77 | 41 / 56 / 65 |
| `IDBMirrorVFS` | 26 / 46 / 110 | 29 / 48 / 110 |
| `MemoryVFS` / `MemoryAsyncVFS` | 24 / 40 / 94 | 26 / 40 / 91 |

Spread within a Chromium cell under 1 MB in most cells. 50 MiB of payload is 66.8 MiB logical.

- **A worker costs ~10 MB of PSS**, on a wasm heap of 16.6 MiB that is identical on every VFS. At small sizes the worker count weighs more than the VFS.
- **SQLite's page cache sits at 2.0 MiB everywhere** — `cache_size`'s default bound, read through `db_status`.
- **`memoryModel: 'whole-database'` holds**: `MemoryVFS`, `MemoryAsyncVFS`, `IDBMirrorVFS` keep about the database's size, JS-side (the wasm heap does not move).
- **`OPFSAnyContextVFS`, declared `page-cache`, grows with the data**: anonymous memory of the page's process outside the JS heap (`measureUserAgentSpecificMemory` stays at 37 MB), peaking at 101 MB at 50 MiB on Chromium and 180 on Firefox, partly returned within 10 s; plus ~34 MB in Chromium's other processes. Cause not traced.
- **`IDBBatchAtomicVFS` carries its cost outside the page on Chromium**: ~61 MB in the other processes at 50 MiB, still there 12 s later — presumably the IndexedDB backend. `IDBMirrorVFS`: ~6.
- File-backed PSS is flat at ~13.7 MB (Chromium) / ~5 MB (Firefox) on every VFS: none of this is mapped files.

## FOOTPRINT-DISK — on-disk size against logical size

Allocated bytes after close, ratio to `page_count × page_size`, 50 MiB payload:

| VFS | Chromium | Firefox |
|---|---|---|
| OPFS VFS | 1.00 | 1.01 |
| `IDBBatchAtomicVFS` | 0.83 | 1.26 |
| `IDBMirrorVFS` | 0.91 | 1.15 |

Firefox adds ~0.5 MiB per origin (1.35 at 1 MiB). The data is hex text, compressible; the IndexedDB ratios depend on it. **`OPFSWriteAheadVFS` leaves its write-ahead in `-wa1` at close**: at 10 MiB, 5.6 MB main file + 8.5 MB `-wa1`, same total. **What a page can read**: the OPFS sum is exact, the IndexedDB cursor sum gives the logical size (±1 %), not the physical one. **For memory a page reads nothing that tells VFS apart** — wasm heap and `db_status` are the same on all of them.

## BULK-RELEASE — a 500 MiB `bulkWrite()` gives its memory back

Same harness. One `bulkWrite('t', ['id', 'v'])`, no transaction, default `queueSize`, each `enqueue()` awaited, 1 KiB rows; then 15 s idle, then `close()`, sampled every second. n=3, every VFS, 50 and 500 MiB, both engines, 0 errors in 108 runs; plus 4 VFS × n=3 × both engines held 60 s with the client open.

Page process, PSS delta, MB, median (Chromium / Firefox):

| | peak during load | +16 s | +61 s, client open | `close()` + 31 s |
|---|---|---|---|---|
| `OPFSWriteAheadVFS` | 511 / 274 | 207 / 52 | 54 / 18 | 14 / ≤0 |
| `OPFSAdaptiveVFS` | 411 / 274 | 183 / 134 | 49 / 37 | 11 / ≤0 |
| `IDBBatchAtomicVFS` | 377 / 423 | 65 / 165 | 51 / 41 | 11 / ≤0 |
| `MemoryVFS` | 1 432 / 1 690 | 854 / 799 | 713 / 699 | 12 / ≤0 |

- **Live data is small during the load**: after GC, ≤ 50 MB of JS per worker and 1 MB in the page, at 50 MiB as at 500 MiB. The rest of the peak is freed memory the engine has not returned yet.
- **The wasm heap grows once, 16.6 → 24 MiB per worker, at 50 and at 500 MiB alike** — one batch's bindings. It never shrinks; it goes with the worker at `close()`.
- **Return is lazy but complete**: an open client is back to its normal footprint within ~60 s; `close()` returns the rest.
- **The whole-database VFS keep the database**, by design: 700 MB-1 GB live for 500 MiB, peaks of 1.1-1.7 GB, all returned at `close()`.
- **Outside the page, Chromium**: `IDBBatchAtomicVFS` and `OPFSAnyContextVFS` peak at ~100 MB in the other processes; ~40 MB stays for `IDBBatchAtomicVFS` after `close()`.
- Load times, 500 MiB: Chromium 2-5 s on the OPFS sync-handle VFS, 27 s `IDBBatchAtomicVFS`, **107 s `OPFSAnyContextVFS`**; Firefox 33-121 s.

## BULK-PLATEAU — the peak does not track the volume, and is not proven bounded

Timelines of the 500 MiB loads lasting ≥ 20 s (Chromium: `IDBBatchAtomicVFS`, `OPFSAnyContextVFS`; Firefox: every VFS). The page process oscillates in a GC sawtooth — 200-420 MB on the VFS that do not keep the database — with no visible climb: per-third maxima such as 252 / 267 / 266 (Firefox WriteAhead) or 367 / 308 / 321 (Chromium AnyContext, a 109 s load). **But a least-squares slope over the load is small and mostly positive: −0.4 to +2.4 MB/s, against 4-19 MiB/s written.** 50 → 500 MiB took Chromium's peak from ~195 to ~400-510 MB, not ×10. So the peak does not scale with the data, and the live set is bounded by back-pressure; **that the sawtooth's top saturates is not established** — a load several times longer would settle it. The whole-database VFS climb at +17 to +36 MB/s, which is the database itself.

## BULK-GC — the peak is collectable garbage, and pacing the GC halves it, 2026-10-06

Same harness, 500 MiB `bulkWrite`, n=3 per arm, 0 errors. Page-process PSS peak, MB, median; load time unchanged in every arm unless noted.

**Heap cap** (measurement-only flags). Chromium `--max-old-space-size`:

| VFS | default | 128 MB | 64 MB |
|---|---|---|---|
| `OPFSWriteAheadVFS` | 540 | 457 | **229** |
| `OPFSAdaptiveVFS` | 404 | 325 | **194** (load 3 → 4 s) |
| `OPFSCoopSyncVFS` | 406 | 319 | **179** |

So under a constrained heap V8 collects earlier and the load completes: the excess is slack, not need. **Firefox `javascript.options.mem.max` (MB, applied to workers as `JSGC_MAX_BYTES`): no effect at 128 or 64** — 276-312 MB in every arm, no failure. It is a hard maximum, not a trigger, and Firefox's peak (~280) already sits below Chromium's default.

**Forced GC at batch boundaries** (Chromium, `--expose-gc`; `gc()` in the page every 16 383 rows, and/or in the worker after each `done` reply, through the hook wrapping `self.postMessage`):

| VFS | none | page | worker | both |
|---|---|---|---|---|
| `OPFSAdaptiveVFS` | 418 | 303 | 307 | **210** |
| `OPFSWriteAheadVFS` | 551 | 459 | 389 | **314** |

The page and the worker each hold about half of the garbage; the gains add up.

**Where it lives** — CDP `Runtime.getHeapUsage` per target, sampled every 500 ms, no GC (Chromium, n=2): during the load the page's V8 heap holds 40-109 MB used / 90-150 committed, each busy worker 13-74 used / 60-113 committed, and `OPFSWriteAheadVFS`'s worker up to 156 MB of ArrayBuffer backing stores. **20 s after the load nothing has run**: the page still counts 58 MB used / 106-122 committed, where a forced GC leaves 1 MB live.

**Per batch the page builds**: one array per row (`keys.map(toBindable)`), a copy of the buffer (`[...buffer]`), a flattened array of 32 766 values (`toInsert.flat()`), the SQL text — all alive until the batch is posted, then the structured clone. **`queueSize` does not shrink a batch** (`maxBufferSize = floor(32766 / keys)` is fixed); below one batch it only means one batch in flight.

**No normal-configuration way to trigger a GC was found** (web search, same day): `gc()` needs `--expose-gc`; V8's memory reducer starts a GC only once the allocation rate is low (`kShortDelayMs = 500`, watchdog `kWatchdogDelayMs = 100000`, `src/heap/memory-reducer.cc`); Firefox gives each worker a shrinking GC 5 s after it goes idle and a normal GC every 30 s while busy (bugzilla 718100, 2012); wasm `memory.discard` is still a Phase 1 proposal. What others report doing instead: transfer ArrayBuffers rather than clone, bound the queue, terminate a worker to free its whole heap.

BULK-BINARY, BINARY-PROTOCOL, RESULT-BINARY and the 2026-10-08 entries on the binary protocol moved to `mem:measurements/binary-protocol` on 2026-10-08.

## STREAM-FF — Firefox held every streamed chunk, and memory per query: three retentions, fixed on `main` 2026-10-07

**Measure Firefox memory WITHOUT Playwright** (FF-JUGGLER below): every figure in this section that says "direct" comes from Playwright's Firefox 153 binary launched by hand (`--headless --no-remote --profile`), the page running itself from its query string and posting marks to the harness, PSS read from `/proc` by profile path, chunk liveness read in the page with a `FinalizationRegistry` (tenured witnesses prove a major GC ran). Same data throughout: `OPFSAdaptiveVFS`, 500 MiB (512 000 rows of 1 KiB text), rows discarded as they arrive, default `chunkSize`.

**Direct, n=3 per arm, 0 errors** — page-process PSS peak over the phase start, and chunks finalized DURING the read:

| arm | peak MB | freed during | after the read |
|---|---|---|---|
| `stream()` today | 2 134 (2 125-2 140) | 0 / 1 000 | +2 084 at +38 s |
| `chunk()` today | 2 083 (2 083-2 084) | 0 / 1 024 | +2 069 at +38 s |
| `stream()`, pool fix | **539** (293-592) | 779-968 | +175 |
| `chunk()`, pool fix | **803** (713-1 001) | 627-920 | +40 |
| `stream()` + signal, pool fix | 2 131 (2 113-2 138) | 0 | freed after the query, timing varies (-7 to +2 137 at +38 s) |
| `stream()` + timeout, pool fix | 2 132 (2 130-2 139) | 0 | +78 |
| `chunk()` + signal, pool fix | 2 083 (2 062-2 086) | 0 | +148 |
| `tx.stream()`, no caller signal, pool fix | 2 129 (2 099-2 134) | 0 | -14 to +2 063 |
| `stream()` + signal, both fixes | **562** (520-576) | 914-959 | +162 |
| `stream()` + timeout, both fixes | **529** (399-544) | 778-928 | +27 |
| `chunk()` + signal, both fixes | **732** (303-755) | 648-919 | -26 |
| `tx.stream()`, both fixes | **699** (540-734) | 742-971 | +117 |

Read time 17-21 s in every arm: neither fix costs time. **Chromium is not affected** (Playwright, which is neutral there): 54-74 MB on every arm, with or without signal, in a transaction or not.

**Retention 1 — the pool's chunk wait.** `src/pool.ts`'s read loop awaits `Promise.race([waiting.promise, stopRequested.promise, lost.promise, deathDeferred.promise])` once per chunk, and the `chunk` handler resolves `deferredChunk` WITH the rows although the loop only compares the outcome to `STOP`. `deathDeferred` lives as long as the worker; each race leaves a reaction on it that keeps the race's result — the rows — alive until the worker dies. **Fix: resolve `deferredChunk` without a value.** Pure-JS reproduction, direct Firefox, n=2: 1 024 races against a never-settling promise, PSS 15 s later, **201-203 MB resolved with 512 rows, 19-22 MB without** (Chromium under Playwright: 36 / 21). Ruled out on the way, under Playwright: the OPFS read path (a full scan returning no row +18 MB), the VFS (`IDBBatchAtomicVFS` the same), the JS heap cap (`javascript.options.mem.max` changes nothing), the worker's strings (the binary return holds as much).

**Retention 2 — the abort races.** `src/queries.ts:164`/`:269` race `iterator.next()` against `makeAbortRace`'s `aborted`, and `src/transaction.ts:751` does the same, once per chunk. `aborted` lives as long as the query, so the whole result is held for the query's duration — with a caller `signal`, with a `timeout` (`withDeadline` makes it a signal), and in **every** `tx.stream()`: a transaction hands its statements a signal of its own (`withSignal` → `st.options`/`st.driving`). `teardown()` detaches the listener at the end, so it does not outlive the query. **Fix (spike `raceAbort`): one `abort` listener per wait, removed when the wait settles, `signal.aborted` tested first so an abort already fired still wins** — what putting `aborted` first in the array did.

**Applied on `main` (2026-10-07, merge of `fix/firefox-stream-retention`)**: `deferredChunk` resolved without a value; `raceAbort(signal, pending)` in `queries.ts` (one listener per wait, `signal.aborted` first, `pending`'s rejection handled when the signal had already fired) at the three per-chunk sites, `makeAbortRace` kept for the one-shot waits; and a third retention found while checking the residue: **every wait of the pool's read loop left a reaction on the pending `deathDeferred`, about 430 bytes each on SpiderMonkey** (direct Firefox, 1 000 000 races resolved without a value against a never-settling promise: +462/+472 MB, against +40/+41 without the pending input; V8 under Node: 0 bytes). At least two waits per query, so **~0.9 KB per query of any kind, held until the worker dies**: 200 000 `read('SELECT 1')` on one `MemoryVFS` worker, direct Firefox, n=2, **+180/+189 MB on rc.7's code, -19/-2 MB fixed**, 54-56 s either way. Fix: the loop races `lost` instead; `poison()` rejects the query's `lost`, and a query posted after the death gets `lost` rejected at creation (`deathDeferred.promise.catch(lost.reject)`), so every wait settles exactly as before.

Re-measured on the merged code against rc.7's (`main` before the branch), direct Firefox, same data, n=3, 0 errors in 36 runs — peak MB (range), chunks finalized during the read:

| arm | before | after | freed during, after |
|---|---|---|---|
| `stream()` | 2 050 (2 009-2 052) | 495 (428-503) | 758-890 / 1 000 |
| `stream()` + signal | 2 054 (2 039-2 079) | 293 (278-427) | 883-956 |
| `stream()` + timeout | 2 062 (2 011-2 064) | 491 (336-496) | 798-919 |
| `tx.stream()` | 2 041 (2 018-2 054) | 545 (459-662) | 789-845 |
| `chunk()` | 1 997 (1 987-2 007) | 725 (556-876) | 550-690 / 1 024 |
| `chunk()` + signal | 1 981 (1 968-2 073) | 710 (544-974) | 609-954 |

Before: 0 chunks freed in every arm. Read 16-21 s in both. **What stays after the read is uncollected garbage, not retention**: the page idles and Firefox does not collect it (chunk() +706 MB at +38 s), but 4 s of allocation after the read brings `chunk()`, `chunk()` + signal and `stream()` to +24/-1/+15 MB at +38 s (n=3). **Chromium control (Playwright, n=3), rc.7 against fixed: 26-41 MB peaks, read 1.6-1.8 s, identical** on every arm.

**Tests that fail without each fix run in the ordinary Playwright suite** (`tests/browser/firefox/stream-retention.test.ts`, ~200 ms a case): read with `next()` by hand, stop mid-query with 30 chunks taken, allocate garbage that survives minor GCs until 30 tenured witnesses are finalized, then count — 29/30 freed with the fixes, 0/30 without, on every arm including `chunk()`. Ablation: without the pool fix 12/12 fail, without `raceAbort` exactly the 8 signal/timeout/`chunk()`+signal/`tx.stream()` cases (two targets). **Relying on natural GC under Playwright was unusable**: the first case in a page freed 58/80, later ones 0 even with witnesses finalized, and a case alone often saw no major GC at all. The `deathDeferred` reaction holds no value a `FinalizationRegistry` can see, so it has no retention test; `tests/browser/pool-death.test.ts` pins the path the fix added (a query posted after the death rejects with the death error — green on rc.7's `pool.ts`, hangs without the new line).

## FF-PW-AWAIT — Playwright's Firefox binary is 10-30× slower on `await` even launched by hand; time Firefox on a stock build, 2026-10-08

Found tracing the narrow-row slowness (`mem:follow-ups`). Pure JS, 4 000 000 iterations, same page and module worker, direct harness: Playwright's `firefox-1538` (Firefox 153) launched by hand against a stock Mozilla Firefox 157 (linux-aarch64 tarball) launched the same way, Chromium for reference, ms:

| loop | Playwright Firefox | stock Firefox | Chromium |
|---|---|---|---|
| `await` a value | 400-417 | 21 | 63-66 |
| `await Promise.resolve(x)` | 3 052-3 080 | 102-106 | 54-55 |
| `await` an `async` function with no inner `await` | 4 068-4 102 | 211-217 | 40-41 |
| `await` an `async` function that awaits | 11 886-12 061 | 1 451-1 574 | 203-205 |

The same in the page and in a worker. **So every Firefox TIME this project took with `firefox-1538`, under Playwright or launched by hand, overstates the cost of `await`** — reads, streams and anything with an `await` per row or per message. Not traced to a cause: its packaged prefs carry the stock `javascript.options.asyncstack` values; Juggler making every realm a debuggee (so async stacks are captured) is the hypothesis, consistent with FF-JUGGLER. Memory figures are not known to be affected. **Rule from now on: a Firefox timing that matters is taken on a stock Firefox**, the Playwright binary staying for the test suite.

## FF-JUGGLER — Playwright's Firefox retains every value consumed by `for await`, 2026-10-07

Found because `chunk()` under Playwright climbed to ~2 GB even with both fixes. Pure JS, 600 chunks of 512 rows, each chunk registered in a `FinalizationRegistry`, a 20-chunk ring of tenured witnesses proving major GCs run: **under Playwright, 0 of 600 chunks are ever finalized** whenever they are consumed through `for await` — one async generator, a stack shaped like the library's, or a hand-written async iterator with no generator at all — while a plain loop with the same awaits frees 523-563 and a sync generator 523. **The same binary launched without Playwright frees 509-513** for the generator and the hand-written iterator alike. Chromium frees them under Playwright. So it is Juggler's instrumentation, not SpiderMonkey. Consequences: every Firefox figure under Playwright for a path the page consumes with `for await` (`stream()`, `chunk()`, `tx.stream()`) overstates memory — the 2026-10-06 STREAM-FF numbers (+2.3 GB, then +1.34 GB "with the fix", the `chunk()` "open question") were all inflated by it — and **Juggler roughly halves Firefox's speed** here (the same read: 40-54 s under Playwright, 17-21 s direct). Paths without `for await` in the page (`bulkWrite`, `read()`) were not re-measured directly. **A page that calls `next()` by hand and forces a major GC by allocation does see chunks freed under Playwright** (2026-10-07, 29/30 on every arm, the library's own internal `for await` notwithstanding) — the method the retention tests use (STREAM-FF).

