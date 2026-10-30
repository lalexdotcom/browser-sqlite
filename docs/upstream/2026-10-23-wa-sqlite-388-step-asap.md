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

## `allowed` inside `done`: a Firefox inlining limit (2026-10-25)

The "will do" on `allowed` was answered "costs nothing" without a measurement. Measured while preparing the revision, it is wrong: **Firefox `sync` +7 %**, Chrome nothing. Located by crossing glue and API (the rebuilt glue costs nothing, the revised API +6 %), then by variants of `done` (Firefox `sync`, 12 pages × 2 passes, medians against the head; `make-why.py`, `site/why-worker.js`):

| variant of `done` | Firefox `sync` |
|---|---|
| `allowed` outside (the PR) | +1 % |
| `allowed` inside (his suggestion) | **+7 %** |
| the literal passed straight to `check()` | **+6 %** |
| `allowed` outside, plus unreached code of the literal's size, no array | **+6 %** |
| the literal in a separate `fail()` that `done` calls on the error path | 0 % |

**Cause: SpiderMonkey's inlining size limit.** `done` sits just under the bytecode length up to which SpiderMonkey inlines a function into its caller (`retryResult`); two lines, even unreached, push it over, and each row pays a real call. Proven through the pref itself, `javascript.options.inlining_bytecode_max_length` set in the profile's `user.js` (`run-why-pref.sh`): at 1000 every variant runs ~227 ms, at 20 every one ~298 ms, the gap gone both ways. Comments are not bytecode and change nothing.

**Corrected on the PR the same day** (user-validated, short: the gap on Firefox, none seen on Chrome or Safari, the cause, keep `allowed` where it is, the `fail()` shape offered if he still wants the array on the error path only): [discussion_r4371790074](https://github.com/rhashimoto/wa-sqlite/pull/388#discussion_r4371790074).

## Safari spike (2026-10-25)

To claim no cost on other browsers, the head against the revision measured on Safari through a throwaway CI spike (branch, workflow and runs deleted the same day, user; scripts in `.scratchpad/step-asap-bench/safari-spike/`, results in `safari26/`, `safari27/`, `safari26v/`). Per page: `head`, `head2` (a second instance, the control), the revision with `allowed` inside, outside, and in `fail()`; 5 pages per build, creation order rotated. Read as each arm's best time against the same page's head, median over pages (the medians alone are unusable there, see below).

| | `head2` (control) | `allowed` inside | `allowed` outside | `fail()` |
|---|---|---|---|---|
| Safari 26.6.2 `sync` | +4 % | −10 % | −2 % | −2 % |
| Safari 26.6.2 `async` | −2 % | +1 % | −1 % | +3 % |
| Safari 27.0.1 `sync` | −1 % | +2 % | +2 % | +1 % |
| Safari 27.0.1 `async` | 0 % | 0 % | 0 % | +2 % |
| Safari 27.0.1 `jspi` | −2 % | **−38 %** | **−38 %** | **−39 %** |

No cost of the revision on Safari within its ±5 % precision, and no difference whether `allowed` is inside or not. **JSPI with the export called directly: −38 % on Safari 27** (no JSPI on Safari 26: the glue fails in `instrumentWasmImports`), against −12 % on Chrome and −8 % on Firefox (`rev-worker.js`, 5 pages × 2 passes: Firefox / Chrome `jspi` 2 998 / 1 338 → 2 744 / 1 174 ms; `sync` and `async` within ±2 %, Firefox `sync` +9 % being `allowed`). That `ccall` costs most there is an argument for the `libadapters.js` part.

**Why Safari's times vary so much** (a variance run on macOS 26: 8 pages alternating 1 and 5 instances, the head measured 12 times each beside a calibration loop, the host sampled after each page): instance count is not it (k=1 and k=5 alike, Safari at 840 MB and 1.5 GB); the runner's load average was 16-42 on 3 cores, falling through the job; the step loop varies ±20-30 % within a page where the calibration (a typed-array sum) varies ±8 %. The runner's noise, which a pass over 4 000 000 rows of wasm memory feels more than a small CPU loop (not verified further). Per-page pairing keeps it to about ±5 %.

## The revision prepared (2026-10-25, sent on 2026-10-30 with the next section)

In `.work/wa-sqlite-step-asap`, committed locally on `step-asap` as `34d46069` and not pushed, the PR left as is until rhashimoto answers (user). Built on the assumption that our suggestions are accepted:

- **The JSPI path**: `src/libadapters.js` sets `Module.asyncMode` from the library preprocessor (`#if ASYNCIFY == 2` → `'jspi'`, `#elif ASYNCIFY` → `'asyncify'`, else `null`; emsdk 3.1.61's `-sJSPI` sets `ASYNCIFY = 2`, `emcc.py`); `step_asap()` takes `ccall` only when `Module.handleAsync && Module.asyncMode !== 'jspi'`, so a build without `asyncMode` (an older `dist/`, a custom build) stays on `ccall`. `dist/` rebuilt with `wa-sqlite-emsdk:3.1.61` after a rebuild of the head reproduced `dist/` byte for byte: the three `.mjs` differ by the one `Module["asyncMode"]=…` statement, the `.wasm` not at all. **wa-sqlite's `Makefile` does not list `libadapters.js` among `dist/`'s dependencies: `make dist` rebuilt nothing, `make -B dist` did.**
- **A test**: "knows which asynchronous build it runs on" (`module.asyncMode` per build), red on the old `dist/` on all three builds.
- **The three `index.d.ts` wordings**, as he wrote them.
- **`allowed` stays outside `done`**, as in the PR.
- **The two promised comments**: on `step()` (`Promise.resolve()` passes the Promise on as is; an `async` function is measurably slower) and on the early return (an optimization sparing `check()`'s `includes()`; keep `done` short so Firefox still inlines it, two more lines cost it ~7 %).
- **Unchanged**: the closure shape (his call; we kept `stmt` as an argument).

Upstream suite on Chrome with it: 16/16 files, 8 006 passed. To send: adjust to his verdicts, push, a reply on the JSPI path (with the three engines' gains); then regenerate the patch with the rebuilt glue.

## His verdicts and the revision sent (2026-10-30)

rhashimoto answered the numbers on 2026-10-30. He usually prefers readability to micro-optimizations and is "not particularly swayed by performance arguments specific to Firefox with its single-digit market share", but `step()` is one of the library's most used calls, so: **ignore all his code change requests, with comments saying why; make the other comment edits; no `ccall` on JSPI, "maybe test for Asyncify" so those blocks can be deleted if Asyncify is removed; and reimplement `exec()` on `step_asap()`.** His message also mused that "future me, equipped with powerful AI tools", may no longer read code; the user read it as reluctant, not bitter, and answered with empathy (below).

**The revision, `cba3a633`** on top of `34d46069` (the previous section), user-validated:

- `step_asap()` takes `ccall` only when `Module.asyncMode === 'asyncify'` ("This branch goes when Asyncify does"); a build without `asyncMode` now calls the export directly, which is safe because `dist/` is rebuilt and every `Makefile` build includes `libadapters.js`.
- `exec()` steps with `step_asap()`, awaiting only a Promise (the `index.d.ts` example's shape); `await callback(...)` unchanged.
- `allowed` created only on the error path, in a small `fail()` that `done` calls: his `allowed` request met without the +7 % (user: "on garde cette option"). The function form is what SpiderMonkey's inlining limit needs; **no browser is named in the code or comments (user)**: "small enough for the JIT to inline it".
- A comment on why the statement goes through `retry()` to `done` instead of closures.
- Upstream suite on Chrome 156: 16/16 files, 8 006 passed.

### Measured, and a benchmark trap

Same setup as 2026-10-25 (Chrome 153 / Firefox 155 headless, `MemoryVFS`, 4 000 000 rows, 2 passes per page, medians of per-page ratios). Scripts in `.scratchpad/step-asap-bench/` (`site/rev2x-worker.js`, `site/failx-worker.js`, `run-rev2x.sh`, `run-failx.sh`, results `rev2x.jsonl`, `failx.jsonl`).

**Trap: arms that import the same ES module share its JIT feedback.** Two instances built from one `sqlite-api*.js` or one glue `.mjs` share its compiled functions and inline caches; with two `Module` objects flowing through them they go polymorphic and slow down. Found when a control (`rev2b`, an exact copy of `rev2` importing the same file) came out +4 to +43 % slower than `rev2` while `fail()`, in its own file, looked 10 % faster. It also explained a 6-11 % "gain" on Asyncify for code identical between head and revision: head shared `wa-sqlite-async.mjs` with `master`, the revision had its own `-rev.mjs` (an `async` control with `head2` and the revision on the old glue pointed at the glue; a shape-of-`Module` hypothesis was withdrawn). **Fix: one module per arm, `import(\`${path}?arm=${name}\`)`.** With it the control stays within ±3 %. The 2026-10-25 JSPI figures are unaffected (head and revision each had their own glue); the review arms shared one glue, equally.

Revision against the PR head (`947a3996`), one module per arm, 6 pages × 3 builds × 2 engines, Firefox / Chrome:

| build | `step()` | `step_asap()` | `exec()` | `exec()` with a callback |
|---|---|---|---|---|
| `sync` | +1 % / 0 % | +1 % / +2 % | −42 % / −34 % | −22 % / −10 % |
| `async` | +2 % / +2 % | −1 % / 0 % | −21 % / −22 % | −9 % / −9 % |
| `jspi` | −6 % / −16 % | −5 % / −12 % | −11 % / −14 % | −11 % / −8 % |

`exec()` against `master` on `sync`: 3 440 → 270 ms / 927 → 260 ms. `fail()` against the revision without it, same design with the control: within ±2 % on every build, engine and loop (`step_asap()`, `exec()`, `exec()` with a callback).

### Posted

`step-asap` pushed `947a3996..cba3a633` (fast-forward; the PR now has three commits; `34d46069`'s message still says a build without `asyncMode` is taken for Asyncify, corrected by `cba3a633`, history not rewritten). Reply [issuecomment-6524327972](https://github.com/rhashimoto/wa-sqlite/pull/388#issuecomment-6524327972), the user's text translated (draft `.scratchpad/388-reply-2026-10-30.md`): the list of changes with `exec()`'s range "11 to 42 % … 8 to 22 % with a callback, Chrome included"; on Firefox, that it is the easiest to measure in the user's dev environment, that most such gains are on the path without `readwrite-unsafe` where Safari behaves alike and every iOS browser runs on Safari's WebKit (checked: the EU since iOS 17.4 and Japan since December 2025 allow other engines, none shipped as of 2026), that `fail()` being a function is pure SpiderMonkey JIT; a joke about Windows and Firefox; and empathy on handing one's code to an agent, the PRs having to suit him. Review re-requested by the user.

## What stays ours

- **Not carried in the patch**: `src/worker/step.ts` already gives the library the gain.
- **At the repin that brings it**: the worker's two call sites call `step_asap()`; `step.ts` and its fingerprints in `tests/unit/lib/wa-sqlite-pin.test.ts` are deleted.
- **Since 2026-10-23 the patch carries #388** (`mem:stack-and-build/wa-sqlite`), and the two items above are done. **Since 2026-10-30 it carries `cba3a633` with the three rebuilt `.mjs` glues**: they must travel together, since without `Module.asyncMode` the revised `step_asap()` would call the bare export on Asyncify. `libadapters.js` is not in the npm package and is not carried.
