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
