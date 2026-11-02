# Follow-up — What the `IDBBatchAtomicVFS` long-statement fix left open (2026-09-14)

**Status: OPEN** — reported to WebKit as [329813](https://bugs.webkit.org/show_bug.cgi?id=329813) on 2026-11-02 (report `docs/upstream/2026-11-02-webkit-329813-omg-asyncify.md`); kept in the backlog, waiting for WebKit's answer (user, 2026-11-02). Nothing to do until then; a note to wa-sqlite was not sent.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

- **On Safari, wa-sqlite's `async` (Asyncify) build slows down after a few long statements, and
  stays slow.** Measured 2026-09-14 on Safari 26.6.2 (IDB-SIGNAL, `mem:measurements`): after four
  ~1.5 s reads, `IDBBatchAtomicVFS` and `OPFSAnyContextVFS` ran their fourth at 11-30 s, and every
  `async` column's cached full scan ran 8-17× slower afterwards; `MemoryVFS` on the `sync` build did
  not move. Not IndexedDB (a 32 MB cache changes nothing), not the library's yield (no signal in the
  probe, and rc.4 shows it). Pre-existing; Chromium and Firefox never showed it. **The `jspi`
  build escapes it** (Safari 27.0, flat long reads and a cached scan back at baseline), and on
  that Safari the bench's two `jspi` columns answer `true` where both `async` ones stay `null`.
  Since 2026-09-24 an omitted `build` loads `jspi` wherever the engine has it, so Safari 27+ escapes
  it by default; `VFS.md`'s `async` note says so. Still open: an upstream report (wa-sqlite or WebKit).

## Reproduced on wa-sqlite alone (2026-11-02, investigation started, user)

Probe outside the repo (session scratchpad `slow/`: `site/probe-worker.js`, `run.mjs`): a module worker importing the installed wa-sqlite (`e4f54a05` + patch) glue, `sqlite-api.js` and a memory VFS, 200 000 `(a, b)` rows; a cached scan `SELECT sum(a + b) FROM t` ×3, four long statements (recursive CTE counting to 15 000 000, one `step`), the scan ×3 again. Playwright 1.64.1's WebKit (`webkit-2370`, UA Safari 27.2) on Linux aarch64, in this container (its system libraries installed by the user with `sudo npx playwright install-deps webkit`). ms:

| build / VFS | scan before | long ×4 | scan after |
|---|---|---|---|
| `sync` / `MemoryVFS` | 8 7 7 | 1 701 1 703 1 700 1 705 | 7 6 7 |
| `async` / `MemoryVFS` | 16 15 15 | **4 026 47 797 47 260 47 789** | **202 197 207** |
| `async` / `MemoryAsyncVFS` (`new`) | 21 17 17 | **3 998 58 115 45 286 44 788** | **191 178 177** |
| `jspi` / `MemoryVFS` | 8 7 8 | 1 735 1 749 1 741 1 739 | 7 7 7 |
| `jspi` / `MemoryAsyncVFS` | 9 9 8 | 1 745 1 689 1 689 1 755 | 8 8 8 |

**Without the library, and without any suspension:** `MemoryVFS` never suspends, yet the `async` build degrades as much as with `MemoryAsyncVFS` — so the cause is the Asyncify-instrumented code itself under JavaScriptCore, not unwinding/rewinding. The first long statement is already 2.4× `sync`'s, the next ones ~28×, and the cached scan stays ~13× slower afterwards. `sync` and `jspi` flat.

## Cause located: JavaScriptCore's OMG tier at optimization level 2, on one function (2026-11-02)

`JSC_*` environment variables reach the worker through Playwright's WebKit (`JSC_useJIT=false`: `sync` 33× slower). Campaigns on `async`/`MemoryVFS` (scripts `campaign1-3.sh`, `row.sh` in the same scratchpad dir):

- **`useOMGJIT=false` removes it** (long 5.3 s ×2 stable, scan 21 ms; baseline 4.0 then 45.7 s, scan 180). `useWasmLLInt`, `useWasmOSR`, `useWasmIPInt` off: no change (so not loop OSR). `useBBQJIT=false`: interpreter-only, 124 s, uninformative.
- **`useConcurrentJIT=false` makes it immediate** (scan 193 ms from the start): the slow state is the OMG code itself, installed as soon as it is compiled. Used from then on with short runs (`long=3000000&nlong=1`).
- **`wasmOMGOptimizationLevel`**: default (2) scan 184 ms / long 9.0 s; **1: 15 ms / 0.49 s** (near `sync`'s 11 / 0.35); 0: 114 / 4.7. No change from `useOMGInlining`, `useB3TailDup`, `useB3HoistLoopInvariantValues`, `useB3SpecializeSelect`, `useB3CanonicalizePrePostIncrements`, `useAirOptimizePairedLoadStore`, `coalesceSpillSlots`, the greedy allocator's loop splitting, `airRandomizeRegs`.
- **One function: `JSC_omgAllowlist`** (a file of DEFINED-function indices, one per line; empty = no OMG): only defined function **1086** (absolute **1151**, 65 imports) in OMG reproduces it all (188 ms / 9.3 s); 1151 alone (taken as defined) = fast. It is the module's largest body, 56 089 bytes in `wa-sqlite-async.wasm` against 31 783 for the same index in `wa-sqlite.wasm` (1 888 defined functions, no name section) — almost certainly `sqlite3VdbeExec` with Asyncify's instrumentation (`wasm-info.mjs`).
- **Ordinary use meets it too:** no long statement, default concurrent JIT, 600 scans of ~14 ms: flat until ~scan 200 (~3 s of cumulated work), then 113 → ~180 ms for good.

**Confirmed on real Safari 27.2 (macOS, the user's Mac, 2026-11-02)** through `site/safari.html` served by `serve.mjs` on port 8131 (results in `safari.jsonl`), same probe, ms: `sync`/`MemoryVFS` scan 7 → 7, long 1 640-1 647; `async`/`MemoryVFS` scan 14 → 175-185, long **4 272, 44 154, 44 006**; `async`/`MemoryAsyncVFS` scan 18 → 172-179, long **4 035, 42 672, 42 547**; `jspi`/`MemoryVFS` 8 → 7, long 1 692-1 700. Short scans only: `async` flat at 13-15 ms until scan #271 (3.7 s of cumulated work), then 173-191 for good; `sync` flat at 6-8 over 300. Same figures as Playwright's Linux WebKit, which reports the same UA (Safari 27.2). **Safari Technology Preview (UA Version/27.0, the user's Mac, 2026-11-02): same** — `async` scan 12 → 196-198 ms, long 4 053, 57 549, 44 931; short scans flip at #275 (3.2 s of cumulated work); `sync`/`jspi` flat.

**No build-side workaround found (2026-11-02, user asked to try)**: a rebuild of `e4f54a05` in `emscripten/emsdk:3.1.61-arm64` (worktree `.work/wa-sqlite-emprobe`, script `build-variant.sh`, variants under the scratchpad's `site/var/`) is byte-identical to the published `dist/`. Link level `-O2`/`-O3`/`-Os`: unchanged (187-232 ms); `-O1`: 60 ms but a 2.6 MB module; `--profiling-funcs` names function 1151 `sqlite3VdbeExec`. JSC's `wasmLarge/SmallPartialCompileLimit` (1 or 1e9): no effect either way. `ASYNCIFY_IGNORE_INDIRECT=1` un-instruments nearly everything (662 KB, `sqlite3VdbeExec` back to 31 783 bytes: every suspension goes through a function pointer), so it is unusable as is; `IGNORE_INDIRECT` + an `ASYNCIFY_ADD` list of the real suspension paths is the one lever left, fragile under `-flto` and unmeasured — not pursued (Claude's recommendation: the WebKit report first).

**WebKit report prepared (2026-11-02)**: `.scratchpad/webkit-omg-asyncify/repro.html` (one file, wa-sqlite from jsDelivr pinned to `e4f54a05`, 400 scans per build) and `report.md`; the repro run on Playwright's WebKit (async 14 → ~190 ms from queries 226-250; flat with `wasmOMGOptimizationLevel=1`, ~10 ms, or `useOMGJIT=false`, ~21 ms), Chrome 156 and Firefox 157 (flat). The user files it (component WebAssembly), then the report goes to `docs/upstream/` under its number.

**Safari 26.6.2 is not measured, by decision (user, 2026-11-02): taken to behave as Safari 27 with `async`** (September's figures on 26.6.2 already showed the same symptom through the library).

Next (proposed): then a WebKit report (JavaScriptCore, Wasm OMG at O2 producing ~10× slower code than BBQ for one large Asyncify-instrumented function; workaround `wasmOMGOptimizationLevel=1`), and a note to wa-sqlite.
