# wa-sqlite #383 — `step()`: a synchronous path when nothing suspends

*2026-10-19 — measured on stock Firefox 155.0.1 and Chrome 153 (container, Linux arm64), wa-sqlite `master` `6238f532`*

[d383]: https://github.com/rhashimoto/wa-sqlite/discussions/383

**Why this is here.** wa-sqlite's `sqlite3.step()` is an `async` function awaiting the `async` `retry()`, so every row of a result pays several promise turns even when nothing suspended. On a large read that wrapper is most of the time, most of all on Firefox. This library no longer pays it: since 2026-10-16 its worker steps through `src/worker/step.ts`, which reproduces `retry()` and `check()` around the per-build call and stays synchronous when the call returned a number with nothing queued. That works, but it copies wa-sqlite internals, guarded at each repin by `tests/unit/lib/wa-sqlite-pin.test.ts`. The Discussion asks whether wa-sqlite wants to offer the synchronous path itself; if it does, `step.ts` and its fingerprints go away.

## Measured

wa-sqlite alone, a module worker importing a build's glue, `sqlite-api.js` and `MemoryVFS` from a clean export of `master` (no patch), 4 000 000 rows of `(a INTEGER, b INTEGER)`, a loop of `step` until it stops returning `SQLITE_ROW`. Browsers launched by hand, headless, fresh profiles, Firefox with its self-update disabled. Three pages per build and engine, two passes per page, arm order alternating; row counts checked on every run. Median ms, Firefox / Chrome:

| build | `step()` today | option 1 | option 2, or 3 skipping the `await` | option 3, callers unchanged (`await`) |
|---|---|---|---|---|
| `sync` | 3 470 / 910 | 485 / 312 | 241 / 218 | 255 / 309 |
| `asyncify` | 3 867 / 999 | 1 016 / 599 | 769 / 485 | 794 / 587 |
| `jspi` | 5 153 / 1 688 | 3 846 / 1 401 | 2 961 / 1 197 | 2 903 / 1 178 |

`_sqlite3_step` called directly on `sync`: 178 / 215.

Option 1 is `step()` kept `async` with the synchronous path inside; option 2 a new method returning `number | Promise<number>`, the caller skipping the `await` on a number; option 3 `step()` itself returning `number | Promise<number>`. The library's own fast step is option 2's code. **Option 3 with callers left unchanged gets nearly option 2's gain on Firefox and on `jspi`** (awaiting a number is cheap); on Chrome `sync` and `asyncify`, about option 1's.

In the library (FAST-STEP, 2026-10-16), the fast step took `chunk()` of the same table on `MemoryVFS` from 1 355 to 686 ms on Chrome and from 4 194 to 839 ms on Firefox on `sync`, with smaller gains on the other builds and every VFS.

## The three options as posted

1. **`step()` kept as it is, without the nested `retry()`.** No API change, every caller gains; part of the cost stays, since the caller still awaits every row (a bit over half of option 2's gain on `jspi`).
2. **A new method beside `step()`** returning `number | Promise<number>`. The whole gain, additive, and the synchronous path becomes a documented contract; one more method, and its callers handle both return types. With it, `step()` can become an `async` wrapper over it, which is option 1 for every existing caller.
3. **`step()` itself returning `number | Promise<number>`.** One method, the whole gain for callers that skip the `await`, nearly as much for those that keep it; breaking (`.then()` on a number, a synchronous throw, the declared type), so a major version.

The invariant any of them must keep is stated in the post: never decide ahead that a call is synchronous, look at what came back (`sync`: `OPFSCoopSyncVFS` queues `retryOps` behind `SQLITE_BUSY`; `asyncify`: `ccall` without `async` returns `whenDone()`'s promise when the VFS unwound; `jspi`: the export always returns a promise).

## Posted upstream

Discussion [#383][d383], category Ideas, opened 2026-10-19. The body, validated by the user, sets out the problem, says a caller can work around it only by copying internals, gives the three options with their pros and cons and the table above, and offers a PR for whichever he prefers. No runnable snippet (user: the maintainer knows his library and will reproduce if the idea interests him). It does not name this library.

## What stays ours

- `src/worker/step.ts` and its fingerprint test, until wa-sqlite offers one of the options; the repin procedure re-reads what it reproduces (`mem:stack-and-build/wa-sqlite`).
- If option 2 or 3 lands: the worker's two call sites switch to it, `step.ts` and `wa-sqlite-pin.test.ts` are deleted. If option 1 lands: nothing to change, but the library keeps its fast step, which stays faster.
