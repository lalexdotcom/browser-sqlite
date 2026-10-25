# wa-sqlite #388 — `step_asap()`: a step without a Promise when nothing suspends

*2026-10-23 — measured on Chrome 153 and Firefox 155.0.1 (container, Linux arm64), wa-sqlite `master` `ced5652e`*

[pr388]: https://github.com/rhashimoto/wa-sqlite/pull/388
[d383]: https://github.com/rhashimoto/wa-sqlite/discussions/383

**Why this is here.** Discussion [#383][d383] asked whether wa-sqlite would offer the synchronous path that this library's `src/worker/step.ts` copies from its internals; rhashimoto took options 1 and 2 and named the method `step_asap()` (report: `2026-10-19-wa-sqlite-383-step-sync-path.md`). This PR is that answer. Once merged and repinned, the worker's two call sites switch to `step_asap()`, and `step.ts` and its fingerprints in `tests/unit/lib/wa-sqlite-pin.test.ts` go.

## Shape, decided with the user

- **Options 1 and 2 in one PR**: `step_asap()` returning `number | Promise<number>`, and `step()` as a wrapper over it.
- **`step()` wraps with `Promise.resolve()`, not `async`/`await`** (the user's question: "won't that be a double async?"). Measured below: the `async` wrapper cost Firefox `sync` 2 378 ms against 632.
- **No change to the WebAssembly build (user).** `sqlite-api.js` cannot tell JSPI from Asyncify, so JSPI goes through `ccall`; the body says so and describes what a `libadapters.js` change plus a rebuilt `dist/` would take, for rhashimoto to judge (user: "on verra ce qu'il en dit").
- **`verifyStatement` kept** (Claude's call, the user deferring): an API misuse check `step()` always made, unmeasurable on JSPI and ~10 ns a row elsewhere.
- **The snippet stays in the body**, not a gist (user). ASAP's expansion stays in the JSDoc only: rhashimoto's "Let's document it as that" read as a wink, not a request to explain it in the PR (user).
- **Tests on Chrome only**, as upstream runs them; Firefox for measurements (user, `mem:conventions/upstream`).

## The change

`src/sqlite-api.js`: `sqlite3.step_asap()` calls the export directly on the build without `handleAsync`, and `ccall` without the `async` option elsewhere (an options object is passed: `cwrap` returns the bare export for numeric signatures otherwise, which on Asyncify cannot see an unwind). `retry(f, arg, done)` returns directly when the call returned a number and left nothing in `retryOps`/`pendingOps`, otherwise a Promise; the final check is its `done` callback, so a Promise costs one continuation. `step()` is `Promise.resolve(step_asap())` with a synchronous throw turned into a rejection. `open_v2()` and `statements()` await `retry()` as before. `src/types/index.d.ts`: `step_asap(stmt: number): number | Promise<number>` with its JSDoc.

## Measured

wa-sqlite alone in a module worker, `MemoryVFS` unless stated, 4 000 000 `(a, b)` rows, browsers launched by hand (Firefox with its update policy), arm order alternating, row counts checked. Median ms, Firefox / Chrome. Scripts and raw results in `.scratchpad/step-asap-bench/` (not committed).

**First draft** (`async` wrapper, `ccall` everywhere, two `.then` per call), 3 pages × 2 passes:

| build / VFS | `step()` master | `step()` `async` | `step()` `Promise.resolve` | `step_asap()` |
|---|---|---|---|---|
| `sync` | 3 396 / 916 | 2 378 / 708 | 632 / 550 | 488 / 438 |
| `jspi` | 4 988 / 1 717 | 4 757 / 1 579 | 3 867 / 1 510 | 3 806 / 1 460 |

**Where it lost against #383's fast step** (241 / 218 on `sync`), one factor removed per arm: on `sync`, `ccall` −175 / −186, `check()`'s `includes` −67 / −6, `verifyStatement` + `Map.get` −52 / −34, the per-row closure −33 / −24; on `jspi` none of those explained the gap, one `.then` per call instead of two did (`onethen` 2 764 / 1 192 against the fast step's 2 756 / 1 153). On the final code, `jspi`, 5 pages × 2 passes: with the export called directly it matches the fast step (2 788 / 1 191 against 2 837 / 1 142), so `ccall` costs ~250 / ~210 ms there (8 % / 15 %); `verifyStatement` costs nothing measurable. The first decomposition had put `ccall` at 136 on Chrome: its arms still carried the double `.then`, and the costs were not additive. A Promise counter in the bench loop inflated Firefox `jspi` by ~180 ms; the final arms drop it.

**The PR's code**, 3 pages × 2 passes:

| build / VFS | `step()` master | `step()` PR | `await step_asap()` | `step_asap()` | fast step |
|---|---|---|---|---|---|
| `sync` | 3 319 / 976 | 424 / 334 | 277 / 346 | 246 / 247 | 240 / 210 |
| `async` | 3 768 / 1 005 | 902 / 636 | 758 / 644 | 738 / 509 | 738 / 477 |
| `jspi` | 4 956 / 1 728 | 3 122 / 1 341 | 3 067 / 1 443 | 3 122 / 1 408 | 2 829 / 1 134 |
| `async` / `MemoryAsyncVFS` | 3 770 / 1 081 | 950 / 686 | 823 / 700 | 802 / 590 | 807 / 564 |

`step_asap()` returned no Promise on `MemoryVFS` with `sync`/`async`, 15 846 per pass with `MemoryAsyncVFS` at `cache_size = 10` (the calls that really suspended), one per call on `jspi`. The snippet in the PR (1 000 000 rows, n=1) gave the same ratios on both engines.

## Equivalence with `master`

Master's `step()`, the PR's `step()` and the PR's `step_asap()` played nine situations (a query; the same on a suspending VFS; `SQLITE_BUSY` once; twice, then on; a pending operation resolved; rejected, then on; a constraint twice; an insert then a select; not a statement), each on a fresh module, recording every result, every VFS call with its arguments and a hash of its bytes, and every `console.error`. **Identical in all 52 cells** (9 situations, 3 builds, 2 engines, the suspending one on 2 builds), once randomness was seeded the same for every caller: SQLite stamps a random nonce into each journal header, and a `master`-against-`master` control differed there too. The probe detects a defect: with `retryOps` ignored the two `SQLITE_BUSY` situations diverge, with the export called directly on Asyncify the run breaks.

## The test, and how it was falsified

`test/sqlite-api-step-asap.test.js`: 9 tests on each build (26 specs), in the page because Comlink turns every return into a Promise, every call checked against the known rows rather than against `step()` (which is now the code under test). Two `MemoryVFS` subclasses reproduce `OPFSCoopSyncVFS`'s `retryOps` behind `SQLITE_BUSY` and a pending operation. Run against `master` and seven wrong implementations, each fails where it should:

| implementation | failed specs |
|---|---|
| `master` | 84 (no `step_asap()`) |
| always a Promise | 7: the synchronous form, the error contract |
| the export called directly on every build | 1: Asyncify suspending (`not an error`) |
| `retryOps` ignored | 25: both `SQLITE_BUSY` cases, every build |
| `pendingOps` ignored | 13: both pending cases |
| errors always rejected | 2: the synchronous error contract |
| the form decided ahead | 10: Asyncify suspending, every JSPI case |
| `verifyStatement` removed | 7: once the message is checked (the code alone passed, `sqlite3_step(NULL)` answering `SQLITE_MISUSE` itself) |

**A harness trap found on the way:** `web-test-runner-jasmine` 0.0.6 sends each failed expectation's raw `expected`/`actual` to the runner, and the WebSocket clones them with `structuredClone`. When `toBeInstanceOf(SQLiteError)` or `toBeRejectedWithError(SQLiteError, …)` fails, `expected` is the class: `DataCloneError` in `sessionFinished`, the end of the session never reaches the runner, which waits out its 120 s with no output. The page itself had finished in 0.6 s (seen through the DevTools protocol). The test checks classes with `instanceof`; upstream's `sqlite-api-open.test.js` has the same latent weakness.

Whole suite on Chrome with the PR: 16/16 files, 8 003 assertions, 0 failed.

## Posted upstream

PR [#388][pr388], opened 2026-10-23 from `lalexdotcom:step-asap`, on `master` at `ced5652e`, one commit (`947a3996`). The body points to #383, describes the change and each build's path, the cost in words, a page rhashimoto can save at the repository root and open through `yarn start` (executed by us on both engines and all builds first), the JSPI `ccall` limit with the `libadapters.js` option, and the test. It does not mention this library. No conflict with #385, #386 or #387 (none touches `sqlite-api.js` or the types).

## Review (2026-10-25)

rhashimoto requested changes on 2026-10-25: "This is great!", and **the JSPI `libadapters.js` option wanted in this PR**, plus eight line comments. Three are wording in `index.d.ts` (Promise examples: "the build supports JSPI" instead of "a VFS operation suspended"; a sentence introducing the code block; his `@returns` text), one moves `allowed` inside `done` (he read `done` as called once; it runs on every step, but `allowed` is only needed on the error path, so moving it there is free). The other three would undo measured choices, so each was measured as a copy of the PR head with only that suggestion applied (`.scratchpad/step-asap-bench/make-review.py`, `site/review-worker.js`, `run-review.sh`, `median-review.py`, `review.jsonl`).

**Setup.** As above, `MemoryVFS`, 4 000 000 rows, headless Chrome 153 / Firefox 155 (user agents checked), all six arms in each page, 5 pages × 2 passes, median ms, Firefox / Chrome. Absolute values run lower than on 2026-10-23 (the PR's `step()` on `sync` 392 / 342 against 424 / 334 and 632 / 550 before); only the gaps within this campaign count. The `async` arm of the first draft was `async function(stmt) { return await sqlite3.step_asap(stmt); }`; rhashimoto's is `async stmt => sqlite3.step_asap(stmt)`, never measured until now.

| build | `step()` PR | `step()` `async` (L770) | `step_asap()` PR | closures (L798/799) | no `ROW`/`DONE` early return (L792) | both |
|---|---|---|---|---|---|---|
| `sync` | 392 / 342 | 544 / 337 | 248 / 249 | 304 / 286 | 305 / 243 | 352 / 294 |
| `async` | 934 / 674 | 1 084 / 676 | 769 / 558 | 786 / 564 | 780 / 536 | 834 / 568 |
| `jspi` | 3 153 / 1 350 | 4 219 / 1 459 | 2 992 / 1 361 | 3 020 / 1 356 | 3 120 / 1 346 | 3 012 / 1 360 |

Per row (gap ÷ 4 000 000), Firefox / Chrome:

| | `sync` | `async` | `jspi` |
|---|---|---|---|
| `step()` as `async` | 38 ns / ≈0 | 37 ns / ≈0 | 267 ns / 27 ns |
| closures | 14 ns / 9 ns | 4 ns / 1 ns | ≈0 |
| no early return | 14 ns / ≈0 | ≈0 | 32 ns / ≈0 |

**Reading.** All three choices hold. The `async` `step()` is the one that matters in absolute terms: +16-39 % on Firefox on every build, +8 % on Chrome `jspi` (the only build where `step_asap()` always returns a Promise for the `async` function to adopt), on the path every existing caller takes, `exec()` included. The closures (`done` capturing `stmt`, `retry(() => f(stmt), done)`) and dropping the early return each cost ~10-14 ns a row, on `sync` only (closures +23 % / +15 %, early return +23 % on Firefox, nothing on Chrome), a quarter of a `sync` `step_asap()` (~62 ns a row): small in absolute terms, but on the build where `step_asap()` gains the most.

**Replied 2026-10-25** (user-validated text, numbers in the top-level comment only): the eight threads answered (`discussion_r4371459295`-`r4371459811`), the summary as [issuecomment-6399942915](https://github.com/rhashimoto/wa-sqlite/pull/388#issuecomment-6399942915). Taken: the `libadapters.js` JSPI path, here, with `dist/` rebuilt on Emscripten 3.1.61 after checking that `master` rebuilds byte for byte (as #375; if the image is gone, rebuild it, user); the three doc edits; `allowed`. Kept, with the numbers: `Promise.resolve()` and the early return, each to get a comment saying why. The closures left to his call. Wa-sqlite's name for the synchronous build is `default` (README parameters, demo URLs, `TestContext.js`); the reply says "the synchronous `default` build" once, since the README's "default build" also means everything `make` produces.

## What stays ours

- **Not carried in the patch**: `src/worker/step.ts` already gives the library the gain.
- **At the repin that brings it**: the worker's two call sites call `step_asap()`; `step.ts` and its fingerprints in `tests/unit/lib/wa-sqlite-pin.test.ts` are deleted.
- **Since 2026-10-23 the patch carries #388** (`mem:stack-and-build/wa-sqlite`), and the two items above are done. The revision regenerates it; with the JSPI path it also carries whichever `dist/` glue the `libadapters.js` change rebuilds, until the merge, as for #375 (clear the rspack caches after).
