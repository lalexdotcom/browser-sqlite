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

## BULK-BINARY — a transferred binary batch cuts the peak by up to 70 %, 2026-10-06

**The spike** (throwaway branch, not merged): `bulkWrite` still sends a `query` message with its INSERT through `write()`; only `params` changes. The page encodes the batch's values into 1 MiB `ArrayBuffer` chunks — tag byte then payload: null, int32, float64, int64, text (u32 length + UTF-8 through `TextEncoder.encodeInto`), blob — a value never straddling two chunks; `params` becomes one object holding the chunks, passed to `postMessage` as transferables (pool.ts). The worker copies the chunks into one `sqlite3_malloc` block and binds every value from it with `SQLITE_STATIC` through `module._sqlite3_bind_*`, freeing the block after `settle()` has cleared the bindings. Same binding semantics as wa-sqlite's `bind` (an integer outside int32 goes as a double, a boolean as an int). Two placements: **`flush`** encodes when the batch is sent, **`enqueue`** encodes each row as it arrives, so the rows die young. **Correctness**: 40 000 rows × 11 columns (int, float, bigint, null, undefined, Unicode text, empty text, JSON, Date, blob, boolean) read back with `typeof()` and `hex()`: the same SHA-256 for the three modes, on three VFS, on both engines.

Page-process PSS peak, MB, median of 3, 500 MiB, normal configuration (no forced GC, no heap cap), 0 errors in 54 runs:

| VFS | Chromium clone / flush / enqueue | Firefox clone / flush / enqueue |
|---|---|---|
| `OPFSAdaptiveVFS` | 401 / 131 / **121** | 301 / 247 / **173** |
| `OPFSWriteAheadVFS` | 515 / 349 / **331** | 284 / 206 / **175** |
| `OPFSCoopSyncVFS` | 401 / 171 / **164** | 294 / 255 / **172** |

Load time unchanged or shorter (Chromium Adaptive and CoopSync 3 → 2 s, WriteAhead 5 → 4 s; Firefox 32-54 s in every mode). **On Chromium the transfer does the work and `enqueue` adds 2-8 %; on Firefox encoding at `enqueue()` is what counts** (−13 to −27 % at `flush`, −38 to −43 % at `enqueue`). Both beat the forced GC of BULK-GC (210 on Adaptive). What stays on `OPFSWriteAheadVFS` under Chromium is its own: CDP saw up to 156 MB of ArrayBuffers in its worker. Wasm heap 24.3 MiB per worker, as before; `close()` + 31 s back to baseline in every mode.

**What generalising it to every query would have to handle**, read from the code: `readWithRetry`/`streamWithRetry` re-post the same `params` once on a SQLite `BUSY` (`OPFSCoopSyncVFS`'s handle transfer), so a query must be encoded at each send, not ahead; a write is never retried, so `bulkWrite` may encode at `enqueue()`. `debugSQLQuery` reads `params` to inline values in the debug log. A transferred buffer comes back usable only if the worker transfers it back (ownership round trip), which is how chunks could be recycled — not measured. A `SharedArrayBuffer` would need COOP/COEP, which the library deliberately does not require.

**Generalised to every query, small payloads cost a little and gain nothing (2026-10-06).** Spike extended: when asked, `pool.ts` encodes any query's `params` at send time into one buffer sized for the worst case and transfers it (retry-safe). Measured per query, the mode alternating at every query, isolated page for a fine clock, 8 rounds, `jspi`; ratio binary / clone of the summed per-query times (per-round range):

| workload | Chromium Memory | Chromium Adaptive | Firefox Memory | Firefox Adaptive |
|---|---|---|---|---|
| 2000 point reads, 1 int param | 1.03 (1.01-1.07) | 0.98 (0.97-1.03) | 1.01 (0.99-1.07) | 0.98 (0.95-1.06) |
| 2000 small writes in a tx, 3 short values | **1.05 (1.02-1.10)** | **1.09 (1.04-1.14)** | 1.07 (1.00-1.20) | 1.02 (0.92-1.09) |
| 500 writes of 10 KB text | 1.11 (0.99-1.25) | 1.00 (0.88-1.07) | 0.93 (0.73-1.20) | 1.05 (0.99-1.16) |
| 50 writes of a 1 MiB blob | 0.94 (0.88-1.16) | 0.96 (0.90-1.04) | 1.02 (0.93-1.12) | 1.02 (0.99-1.04) |

So: reads neutral; small writes 2-9 % slower — a few µs per query (Chromium 0.07 ms per small write); large params neutral in time, their memory gain not measured. A first attempt timing whole workloads per mode was useless on Firefox (the same workload spread 680-5 590 ms between rounds); interleaving per query removed it.

**Memory of large params on an ordinary query** (same day, separate browser per run, n=3, `OPFSAdaptiveVFS`): 200 writes of a 1 MiB text in one transaction, page-process PSS peak over the phase start — Chromium **100 MB cloned (87-116) against 27 binary (26-28)**; Firefox 59 (57-60) against 53 (50-84).

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

## FF-JUGGLER — Playwright's Firefox retains every value consumed by `for await`, 2026-10-07

Found because `chunk()` under Playwright climbed to ~2 GB even with both fixes. Pure JS, 600 chunks of 512 rows, each chunk registered in a `FinalizationRegistry`, a 20-chunk ring of tenured witnesses proving major GCs run: **under Playwright, 0 of 600 chunks are ever finalized** whenever they are consumed through `for await` — one async generator, a stack shaped like the library's, or a hand-written async iterator with no generator at all — while a plain loop with the same awaits frees 523-563 and a sync generator 523. **The same binary launched without Playwright frees 509-513** for the generator and the hand-written iterator alike. Chromium frees them under Playwright. So it is Juggler's instrumentation, not SpiderMonkey. Consequences: every Firefox figure under Playwright for a path the page consumes with `for await` (`stream()`, `chunk()`, `tx.stream()`) overstates memory — the 2026-10-06 STREAM-FF numbers (+2.3 GB, then +1.34 GB "with the fix", the `chunk()` "open question") were all inflated by it — and **Juggler roughly halves Firefox's speed** here (the same read: 40-54 s under Playwright, 17-21 s direct). Paths without `for await` in the page (`bulkWrite`, `read()`) were not re-measured directly. **A page that calls `next()` by hand and forces a major GC by allocation does see chunks freed under Playwright** (2026-10-07, 29/30 on every arm, the library's own internal `for await` notwithstanding) — the method the retention tests use (STREAM-FF).

## RESULT-BINARY — rows encoded in the worker: faster on Chromium, slower on Firefox, 2026-10-06

Spike: with `binaryRows` in the query options the worker encodes each row from SQLite's column API (`_sqlite3_column_type/int64/double/text/blob/bytes`, an integer as its two 32-bit halves) into transferred 1 MiB chunks, no JS string in the worker; `pool.ts` decodes them into the same objects (`TextDecoder` for text, `slice()` for blobs, wa-sqlite's `cvt32x2AsSafe` rule for integers). **Correctness**: `read`, `stream` (chunkSize 333), `chunk` (1 000) and `first` give the same SHA-256 encoded and not, on Chromium and Firefox, two VFS — integers at ±2^53 and ±2^63, floats, Unicode and empty text, empty and non-empty blobs, null, a duplicated column name, 300 KB values spanning chunks.

500 MiB `stream()`, `OPFSAdaptiveVFS`, n=3, without the fixes above, **under Playwright** — so the Firefox columns carry FF-JUGGLER's retention and slowdown, and the binary-vs-clone comparison on Firefox should be redone directly before it is trusted:

| chunkSize | Chromium read s, clone → binary | Chromium peak MB | Firefox read s | Firefox peak MB |
|---|---|---|---|---|
| 50 | 1.9 → 1.6 | 63 → 47 | 52 → 80 | 2 294 → 2 396 |
| 500 (default) | 1.7 → **1.1** | 61 → 78 | 41 → 51 | 2 291 → 2 397 |
| 5000 | 2.0 → **1.1** | 178 → **105** | 39 → 47 | 2 299 → 2 450 |

Chromium: up to 45 % faster, and less memory once chunks are large. Firefox: 20-55 % slower and no memory gain. Firefox timings overlapped with other Firefox runs at times (the fix and diagnostic runs), so the slowdown is consistent across chunk sizes but its size is approximate.

## BINARY-PROTOCOL — page → worker entirely binary, measured direct on both engines, 2026-10-07

**Method.** Throwaway branch `spike/binary-protocol` off `main` (after the STREAM-FF fixes), every behaviour behind a `globalThis.__bsq*` switch. **Both browsers launched by hand, no Playwright**: Playwright's `chromium-1234` binary (`--headless --no-sandbox --user-data-dir`, no other flag; no branded Chrome exists for Linux arm64) and `firefox-1538` (`--headless --no-remote --profile`), page served with COOP/COEP, `jspi` build, PSS of the content processes (Chromium `--type=renderer`, Firefox `contentproc`, descendants of the launched pid) sampled every 250 ms, peak over the phase start. Agent variables stripped. The two engines ran as two parallel chains; the per-query micro of the first campaign ran one browser at a time.

**What the spike does.** Any query's params, encoded at send time into a block (tag byte + payload, as BULK-BINARY), transferred; the worker copies the block into one wasm allocation and binds from it with `SQLITE_STATIC`, never building a JS array. `bulkWrite` encodes each row at `enqueue()` and sends `sql` = `INSERT … VALUES ` plus a `pattern` (the row template) in the block; the row count travels in the block's header (counted by the writer, never derived from the values), and the worker rebuilds `sql + pattern × rows`. The worker does not know it serves a `bulkWrite`. **Correctness**: every arm gives the same SHA-256 as the clone on both engines — 40 000 rows × 12 columns including a `jsonb(?)` column in the pattern, bigint, Unicode, empty text and blobs, booleans, Dates; params arms on 4 000 rows written by `tx.write` plus a read re-posted twice.

**(a) Small queries: no threshold needed.** Per-query interleaving over the arms, 8 rounds × 2 runs, ratio to clone of the summed time, median (range). The spike's shape (fresh buffer, transferred, `malloc` per query) is neutral: pointRead 1.00-1.02, smallWrite 1.01-1.02 (Chromium 0.91-1.16), text10k 0.95-1.01, blob1M 0.92-1.01, on `MemoryVFS` and `OPFSAdaptiveVFS`, both engines. The 2-9 % of 2026-10-06 was measured under Playwright. Copying instead of transferring, a persistent wasm scratch, a buffer recycled through `done`: none improves on it for small queries (recycling up to 1.10 on Chromium small writes). An exact UTF-8 size (a JS scan of each string) costs 1.18-1.23 on 10 KB texts on Chromium.

**(b) `bulkWrite`, 500 MiB of 1 KiB rows, n=3**, page PSS peak MB / load s, median (range), clone → binary (`enqueue` + `pattern` + row mark):

| VFS | Chromium | Firefox |
|---|---|---|
| `OPFSAdaptiveVFS` | 477 → **264** MB, 3.25 → 2.66 s | 233 → **143** MB, 41 (35-47) → 36 s |
| `OPFSCoopSyncVFS` | 527 → **297** MB, 3.07 → 2.39 s | 261 → **132** MB, 35 → 38 (34-40) s |
| `OPFSWriteAheadVFS` | 684 → 593 (452-656) MB, 5.12 → 4.27 s | 243 → **147** MB, 56 → 56 s |

What stays on `OPFSWriteAheadVFS` under Chromium is its worker's (BULK-GC). Chromium direct peaks run higher than under Playwright (clone 477-684 against 401-515), so compare within this table only.

**(c) `pattern` and (d) row safety — 4 000 000 rows of two integers, `OPFSAdaptiveVFS`, n=3** (the case where the SQL text weighs most against the values): peak MB, Chromium / Firefox — clone 149 / 110; binary with the SQL built on the page 50 / 79; **`pattern` 44 / 38**; `pattern` with the cache keyed on `(sql, pattern, rows)`, so a cached statement never rebuilds the text, 38 / 32. Times within noise (Chromium 1.9-2.2 s, Firefox 7.3-8.3 s; clone 2.18 / 8.28). **On Firefox the page-built SQL strings alone are ~40 MB of the peak.** Row safety end to end: unprotected, a mark per row, or converting and checking the whole row before encoding — no measurable difference. Encoder alone (2 000 000 small rows, 12 interleaved rounds): mark +6-8 %, convert +12-22 % (~1-2 and ~3-4 ns per row); 1 KiB rows: none. **Unprotected is not an option**: a value that fails mid-row leaves its first columns in the block, and the batch fails at bind (`bind failed at parameter 32761`); mark and convert refuse exactly the faulty rows (40 of 40 000), digest equal to a load without them.

**Large params on ordinary queries — 200 writes of a 1 MiB text in one transaction, `OPFSAdaptiveVFS`, n=3**, peak MB / s: Chromium clone 101-114 / 0.78-0.84, fresh buffer (B0) 29-40 / 0.62-0.66, **recycled buffer 16 / 0.64**; Firefox clone 129-132 / 9.4-10, B0 50-77 / 9.3-10, **recycled 25 / 9.2**. Decomposed: the recycled page buffer (the worker hands the transferred buffer back in `done`) gives the whole gain, the persistent wasm scratch none (Chromium 37, Firefox 76 alone); exact sizing gains nothing in memory. So the gain is fewer page allocations per query, not the worst-case size.

**Re-measured on the implementation (`feat/binary-protocol` at `b41e924` against `main` at `f796fb8`), 2026-10-07 evening**, same direct harness, each build on its defaults (no switches), n=3, the two builds alternating within each repetition, 0 errors in 84 runs. Another session's Firefox was running on the machine throughout, so absolute times carry its load; the comparison does not, being interleaved. Page PSS peak MB / time, median (range), `main` → branch:

| case | Chromium | Firefox |
|---|---|---|
| 500 MiB `OPFSAdaptiveVFS` | 496 → **269**, 3.48 → 2.61 s | 267 → **146**, 35 → 37 s |
| 500 MiB `OPFSCoopSyncVFS` | 531 → **286**, 3.02 → 2.43 s | 281 → **148**, 36 → 35 s |
| 500 MiB `OPFSWriteAheadVFS` | 759 → **499**, 4.98 → 4.06 s | 254 → **148**, 59 (58-63) → 63 (62-66) s |
| 4 000 000 rows of two ints | 132 → **34**, 2.37 → 2.22 s | 167 → **30**, 8.24 → 8.10 s |
| 200 writes of a 1 MiB text | 57 (36-114) → **25**, 0.80 → 0.63 s | 130 → **64** (55-68), ~10 s both |

**Per query, both builds in ONE page, alternating at every query** (`page-ab.html`: the two `dist` imported side by side, one client each, 8 rounds × 2 runs), ratio branch / `main`: Chromium 1.00-1.03 (no params 1.00-1.01, point read 1.02-1.03, small write 1.01-1.03, 10 KB text 1.00-1.03; per-round 0.89-1.22), Firefox 1.00-1.03 (per-round 0.82-1.20), `MemoryVFS` and `OPFSAdaptiveVFS`. **A first comparison of whole runs read +11 to +26 % on Chromium small queries and was noise**: its ranges overlapped wholly, and alternating within the page removed it — compare per-query costs inside one page or not at all.

**Seen on `main` on the way**: a value `postMessage` cannot clone (a `Symbol`) is not refused by `bulkWrite`'s `enqueue()` — `toBindable` passes it through and the whole batch fails at `postMessage`, 5 460 rows lost in the check (12 columns, two batches). The binary path with a row mark refuses only that row.
