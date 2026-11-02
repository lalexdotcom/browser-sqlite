# WebKit 329813 — OMG makes the Asyncify build's `sqlite3VdbeExec` ~12× slower, for good

*2026-11-02 — measured on Safari 27.2 and Safari Technology Preview (the user's Mac), Playwright 1.64.1's WebKit (`webkit-2370`, Linux aarch64, user agent Safari 27.2), Chrome 156 and Firefox 157 (Playwright, Linux), all in this container except the two Safaris*

[bug]: https://bugs.webkit.org/show_bug.cgi?id=329813

**Why this is here.** Filed by the user as [WebKit 329813][bug] (component WebAssembly, version Safari Technology Preview). On Safari, wa-sqlite's `async` (Asyncify) build runs about 12 times slower a few seconds after it starts working, and stays slow. The library loads `jspi` by default where the browser has it (Safari 27+), so the users exposed are those on Safari 26, which has no JSPI, with a VFS that has no `sync` build, and anyone who passes `build: 'async'` on Safari. `mem:follow-ups/safari-async-slowdown` holds the history and every campaign's figures.

## How it was found

Seen first on 2026-09-14 through the library (IDB-SIGNAL, `mem:measurements/bench-and-devices`): on Safari 26.6.2, after four ~1.5 s reads, every `async` VFS ran its cached scans 8-17× slower, `MemoryVFS` on `sync` did not; on Safari 27 `jspi` escaped it. Left as "an upstream report owed" until 2026-11-02, when a probe on wa-sqlite alone (a module worker, the installed glue, a memory VFS) reproduced it in Playwright's WebKit in this container, then on the user's Safari 27.2 and Technology Preview through a page served from the container.

## Where the time goes

JavaScriptCore reads its options from the environment, and Playwright's WebKit passes them to the worker (`JSC_useJIT=false` made `sync` 33× slower). With `useConcurrentJIT=false` the slow state is there from the first query, which made each run a few seconds.

- **The OMG tier.** `useOMGJIT=false` removes the slowdown (BBQ only, ~21 ms a scan); `useWasmOSR`, `useWasmLLInt`, `useWasmIPInt` off change nothing, so it is not loop OSR.
- **At its default optimization level.** `wasmOMGOptimizationLevel=1`: ~10-15 ms, faster than BBQ; level 0: ~114 ms; the default: ~184 ms. Ten B3/Air options (inlining, tail duplication, loop-invariant hoisting, the greedy allocator's loop splitting, spill-slot coalescing…) change nothing, nor do the partial-compile size limits.
- **On one function.** `JSC_omgAllowlist` takes a file of defined-function indices: defined function 1086 alone (index 1151, after 65 imports) reproduces all of it, an empty list removes it. A rebuild with `--profiling-funcs` names it `sqlite3VdbeExec`, the module's largest body: 56 089 bytes in `wa-sqlite-async.wasm`, 31 783 in `wa-sqlite.wasm`.
- **Nothing suspends.** `MemoryVFS` never unwinds; with `MemoryAsyncVFS` (built with `new`, so it does) the figures are the same. Asyncify's instrumentation of the code is enough.
- **Ordinary use meets it.** Short queries only: flat at ~14 ms, then ~180 ms for good from about the 200th-275th query, after 3-4 s of cumulated work.

## The build

Rebuilt from `e4f54a05` in `emscripten/emsdk:3.1.61-arm64` (Emscripten 3.1.61, clang 19, the version upstream's CI uses): byte-identical to the published `dist/wa-sqlite-async.wasm`. Variants through the Makefile's `EMFLAGS_EXTRA`:

- link at `-O2`, `-O3`, `-Os` instead of `-Oz`: unchanged (187-232 ms);
- link at `-O1`: ~60 ms, a module of 2.6 MB instead of 1.26;
- `ASYNCIFY_IGNORE_INDIRECT=1`: un-instruments nearly everything (every suspension goes through a function pointer), so unusable as is. With an `ASYNCIFY_ADD` list of the real suspension paths it is the one build-side lever left: fragile under `-flto`, unmeasured, not pursued.

## The reproduction

[`repro/2026-11-02-webkit-329813-omg-asyncify.html`](repro/2026-11-02-webkit-329813-omg-asyncify.html), the report's attachment (482106): one file, wa-sqlite loaded from jsDelivr pinned to `e4f54a05`, one module worker from a blob per build (`async`, `sync`, `jspi`), each filling a 200 000-row in-memory table and timing `SELECT sum(a + b) FROM t` 400 times, printing the mean of every 25. Open it and click Run; about 40 s.

## Results

`repro.html`, mean ms per query, first block → last block (Playwright's WebKit: every block):

- WebKit (Linux): `async` 14.3 14.1 14.1 14.0 13.6 13.6 13.7 13.9 21.0 **195.5 192.0 194.0 185.7 196.2 189.4 183.7**; `sync` 6.2-6.8; `jspi` 6.1-6.4.
- Same, `JSC_wasmOMGOptimizationLevel=1`: `async` 13.2 → 10.4; `JSC_useOMGJIT=false`: 21.3 → 21.1.
- Chrome 156: `async` 13.4 → 12.9, `sync` 8.8 → 8.3, `jspi` 10.1 → 9.3.
- Firefox 157: `async` 22.6 → 23.5, `sync` 8.8 → 8.7, `jspi` 8.4 → 8.1.

The probe page on macOS (scan ×3, three long statements counting to 15 000 000, scan ×3; then 300 short scans):

- Safari 27.2: `async` scan 14 → 175-185 ms, long 4.3 s then 44.2 and 44.0 s; `sync` 7 → 7 ms, 1.64 s; `jspi` 8 → 7 ms, 1.69 s. Short scans: `async` flips at #271 (3.7 s of work).
- Safari Technology Preview (UA Version/27.0): `async` scan 12 → 196 ms, long 4.1 s then 57.5 and 44.9 s; `sync` and `jspi` flat. Short scans: `async` flips at #275 (3.2 s).

Safari 26.6.2 was not measured again; taken to behave as Safari 27 on `async` (user), as September's figures through the library already showed.

## What the report said

Title: *OMG at the default optimization level makes a large Asyncify-instrumented function about 12x slower than its BBQ code, permanently.* The symptom, steps, expected and actual, the results above, what isolates it (the options that remove it, those that do not, the one function and its sizes), the build and its variants, and the impact (Asyncify is how such libraries reach asynchronous web APIs and Safari versions without JSPI). Plain text in lists: Bugzilla renders neither Markdown nor a fixed-width font. It does not name this library (user).

## What follows for the library

Nothing to change in the code: `jspi` is already the default where Safari has it. `VFS.md`'s note on Safari and `async` describes the trigger as "a few statements of a second or more"; any few seconds of work trigger it.
