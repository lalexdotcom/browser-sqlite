# wa-sqlite #375 — the `jspi` build makes every synchronous callback pay a suspension

*2026-10-05 — measured on Chromium 151 and Firefox 153 (Playwright 1.62.1), in the container; built with emsdk 3.1.61*

[pr375]: https://github.com/rhashimoto/wa-sqlite/pull/375

**Why this is here.** Since the default build follows the browser, `OPFSAdaptiveVFS`, `IDBBatchAtomicVFS`, `IDBMirrorVFS`, `OPFSAnyContextVFS` and `MemoryAsyncVFS` load `jspi` on Firefox. On that build every synchronous call from SQLite into JavaScript — a VFS method that is not `async`, the authorizer, a user function, a hook — went through a `WebAssembly.Suspending` wrapper, which Firefox charges almost as much as a real suspension. It cost `jspi` about 10 % against `async` on Firefox writes on `OPFSAdaptiveVFS`, and made the authorizer, which `tx.savepoint()` relies on to refuse transaction control, several times dearer there. Carried in [`patches/`](../../patches) since 2026-10-05.

## How it was found

Pricing the authorizer for `tx.savepoint()` on 2026-10-04 (TX-CONTROL-GUARD, `mem:measurements/transactions`): 745.6 µs per 50-column prepare on Firefox `jspi`, against 154.8 µs on `async`. A hand-written wasm module isolated the engine cost: a `Suspending` import whose function returns at once costs 2.2-2.4 µs per call on Firefox and 0.055-0.06 µs on Chromium; a plain import, 0.004 µs on both; a real suspension on Firefox, 2.7-3.0 µs. A copy of the glue that stopped wrapping the synchronous relays brought the prepare down to 144.5 µs (JSPI-SYNC-RELAYS, `mem:measurements/statement-cache-and-perf`).

## The cause

`libadapters.js` defines each relay twice, `SIG` and `SIG_async`, and the C side calls the `_async` one only when the JavaScript method is an `AsyncFunction`. `src/asyncify_imports.json` listed both, and the Makefile passed it as `ASYNCIFY_IMPORTS` to the Asyncify and the JSPI builds. The JSPI glue wraps in `Suspending` every import that is marked `__async` or matches that list. `libadapters.js` already marks exactly the `_async` relays `__async`, and Emscripten adds every `__async` library method to `ASYNCIFY_IMPORTS` by itself (emsdk 3.1.61, `tools/link.py`). So the list added only the synchronous relays.

## The change

The list and the `ASYNCIFY_IMPORTS` flag go, from both builds; a one-sentence comment where the relays are marked `__async` says why the synchronous ones stay plain imports. Rebuilt with `emscripten/emsdk:3.1.61-arm64`, after checking that a rebuild of `master` with that image reproduces its checked-in `dist` byte for byte:
- `wa-sqlite.mjs`, `wa-sqlite.wasm` and `wa-sqlite-jspi.wasm` are unchanged — on JSPI the list only ever acted on the glue;
- `wa-sqlite-jspi.mjs`: the import pattern becomes `invoke_.*|__asyncjs__.*`, and the `_async` relays stay wrapped through their `isAsync` flag;
- `wa-sqlite-async.mjs`: the same pattern change, which is inert at run time — the release Asyncify glue computes the match and uses it for nothing;
- `wa-sqlite-async.wasm`: 1104 bytes smaller, Asyncify no longer instrumenting around the synchronous relays.

The first plan was a separate import list for the JSPI build only. Reading `libadapters.js` and the glue showed the list was redundant for the `_async` relays on both builds, so removing it is the whole fix, and it answers the question the plan had left open — whether `async` gains from dropping the synchronous entries: it does not, measured below.

## Measured

µs per call, a dedicated worker loading wa-sqlite directly, median of 5 pages, each the median of 5 rounds, `master` and the change alternated within each page:

| | Firefox, before | after | Chromium, before | after |
| --- | ---: | ---: | ---: | ---: |
| `jspi`, one-row `INSERT`, `MemoryVFS` | 361 | 102 | 30.1 | 26.4 |
| `jspi`, 50-column `SELECT` prepare, authorizer set | 687 | 140 | 25 | 21 |
| `jspi`, one-row `INSERT`, `MemoryAsyncVFS` | 356 | 100 | 27.8 | 25.4 |
| `async`, one-row `INSERT`, `MemoryVFS` | 93 | 90 | 33.5 | 33.9 |
| `async`, prepare with authorizer | 153 | 153 | 26.7 | 28 |
| `async`, one-row `INSERT`, `MemoryAsyncVFS` | 90 | 90 | 27.4 | 27 |
| cached `step`, `async` / `jspi` | 11.4 / 15.8 | same | 0.5 / 0.9 | same |

`MemoryAsyncVFS` gains too: only its open, close, read, write, size, delete and access methods are `async`; locking, syncing and file controls are inherited synchronous methods.

## The test

No test changes upstream: the change is in what the glue wraps, and the suite runs every build. The whole suite with upstream's own config (Chromium): 6488 passed, 0 failed, before and after. Firefox, through a local Playwright config, file by file: identical before and after — the three `vfs_read_freshness` failures on `OPFSWriteAheadVFS` (it needs `readwrite-unsafe`), and `sql.test.js` run without its `OPFSWriteAheadVFS` configuration, whose `sql_0005` hangs the harness there (WA-FIREFOX-SQL-HANG). A runtime check of the async relays is in those results: every `async` VFS on the `jspi` build passes, so the `_async` relays are still wrapped.

## Posted upstream

PR [#375][pr375], opened 2026-10-05 from `lalexdotcom:sync-relays-plain-imports` (`54c7eea3`), on `master` at `7fcc30df`, with `dist` rebuilt in the same commit, as a contributor's `make (emsdk 3.1.61)` commit did before. The body states the cause with the emsdk line, the engine cost, the change file by file, the table above and the test runs; it does not mention this library. It touches no file #371, #372 or #374 changes. Upstream CI on the head commit is green: [run 37311244461](https://github.com/rhashimoto/wa-sqlite/actions/runs/37311244461), `build (20.x)`, the only check — it tests the checked-in `dist`, then rebuilds and tests again.

## What stays ours

- **The carry.** The patch holds `dist/wa-sqlite-jspi.mjs` byte-identical to the PR's. The rest of the PR is not carried: `wa-sqlite-async.mjs`'s pattern is inert at run time, and `wa-sqlite-async.wasm` is a binary that measured no change. Because the glue is minified onto one line, the hunk repeats that line twice and the patch grows by about 250 KB until the repin drops it.
- **A build cache that served the previous glue.** After the patch changed, `pnpm build` kept emitting the earlier glue until `node_modules/.cache/rspack` was cleared — the case `rslib.config.ts`'s comment on the forced build cache warns of. Check the emitted pattern in `dist/worker/worker.js` after any change to the patch.

## Merged

**Merged on 2026-10-05** by rhashimoto, as `96d91182` on `master`, byte for byte the head `54c7eea3`. It left [`patches/`](../../patches) at the repin to `96d91182` the same day. That repin also brought the rest of the PR, which the patch had not carried: `wa-sqlite-async.mjs`, whose import pattern no longer lists the synchronous relays, and the rebuilt `wa-sqlite-async.wasm`.
