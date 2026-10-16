# A library-side fast `step()` for the worker's row loop

Date: 2026-10-16. Branch: `perf/fast-step`. Background and measurements: `mem:follow-ups/wa-step`.

## Why

wa-sqlite's `sqlite3.step()` is an `async` function awaiting the `async` `retry()`, which awaits the call itself. Every row a query returns therefore pays two or three promise turns even when SQLite and the VFS did everything synchronously. On a stock Firefox that is ~0.65 µs a row against ~0.17 µs of SQLite work; on Chromium the wrapper is still 3-4× the raw call. Measured on wa-sqlite alone (4 000 000 rows of two integers, `MemoryVFS`, stock Firefox / Chromium, ms):

| build | `sqlite3.step()` | fast step |
|---|---|---|
| `sync` | 2 835 / 893 | 216 / 213 |
| `async` | 3 282 / 970 | 707 / 460 |
| `jspi` | 4 409 / 1 641 | 2 400 / 1 118 |

Inside the library, `chunk()` on the same table takes 3.4 / 4.4 / 5.3 s on a stock Firefox and 1.3 / 1.6 / 2.4 s on Chromium; the wrapper is most of it.

The user's decision (2026-10-16): do it in the library now. wa-sqlite is vendored at a pinned commit and bundled into `dist/worker/worker.js`, so reproducing a few of its internals carries no risk between repins, provided every repin checks them. An upstream discussion (or enhancement issue) presenting the two upstream options comes afterwards, as separate work.

## Goals

- Both `sqlite.step()` call sites in `src/worker/worker.ts` — the row loop in `query`'s `run()` and the pragma loop in `open` — stop paying wa-sqlite's wrapper when a step completes synchronously, on every build (`sync`, `async`, `jspi`) and every VFS.
- Behaviour is identical to `sqlite.step()`: same rows, same return codes, same errors (class, `code`, message), same retry and pending-operation semantics.
- A repin cannot silently leave the fast step out of date: a procedure step and a unit test both guard it (§ Guarding the repin).

## Non-goals

- No change to wa-sqlite, its patch, or the pin.
- No public API change in the library.
- No runtime guard in the worker checking the shape of wa-sqlite's internals (user, 2026-10-16). All of wa-sqlite's JS — `sqlite-api.js`, each build's glue, the VFS — is bundled at build time, so what the fast step reproduces is frozen in `dist/`. Only the `.wasm` can be served from elsewhere (`wasmUrl`), and `retryOps`, `pendingOps`, `ccall` and Asyncify's unwinding all live in the JS; a `.wasm` from another wa-sqlite would break against our glue with or without the fast step.
- The upstream discussion is not part of this work.
- Other wa-sqlite wrappers (`reset`, `finalize`, `column_*`, `statements()`) are left as they are.

## Anti-goals — what would make this a failure even if reads got faster

Each build breaks differently if a call is assumed synchronous instead of observed to be:

- `sync`: `OPFSCoopSyncVFS` answers `SQLITE_BUSY` and queues `Module.retryOps`; ignoring them surfaces a false "database is locked".
- `async`: calling the raw export while the VFS (or the library's progress handler) unwinds returns a meaningless value with the operation still in flight, and calling into the module again corrupts Asyncify's state.
- `jspi`: the export always returns a promise; comparing it to `SQLITE_ROW` ends the loop at the first row — a silent truncation.

**The invariant: never decide ahead that a call is synchronous — look at what it returned.** A number with no retry or pending operation before or after the call → synchronous, return the checked code. A promise, or any `retryOps`/`pendingOps` entry before or after the call → the asynchronous path of `retry()` as reproduced below, continuing from the call already made. Never fall back to `sqlite.step()` once the export has been called: that would step the statement twice.

Also a failure: any observable difference in an error a consumer receives (message, `code`, `extendedCode` stamping, `SQLITE_INTERRUPT` handling in `run()`).

## What the fast step reproduces

From the installed `node_modules/wa-sqlite/src/sqlite-api.js` (pin `6238f532`, patch applied):

- **`retry(f)`**: up to two attempts. Before each, if `Module.retryOps` is non-empty, await them all and empty the array (in a `finally`). After the call, if `rc === SQLITE_OK` or `retryOps` is empty: if `pendingOps` is non-empty, await them all; on rejection `console.error('Error in pendingOps:', e)` and return `e.code || SQLITE_ERROR`; empty `pendingOps` in a `finally`; return `rc`. Otherwise (a non-OK code with retry operations queued) attempt again; after the second attempt return `rc`.
- **`check(fname, rc, db, [SQLITE_ROW, SQLITE_DONE])`**: return `rc` if allowed, else throw `new SQLiteError(Module.ccall('sqlite3_errmsg', 'string', ['number'], [db]), rc)`. The library has `db` in scope; `SQLiteError` is the class wa-sqlite exports (the worker already imports it as `SQLite.SQLiteError`).
- **`sqlite3.step`**'s `verifyStatement(stmt)` is not reproduced: it checks the handle against wa-sqlite's private statement map, and every handle `run()` steps came from wa-sqlite's own `statements()` (cached or fresh).

The call per build, read from each glue's `ccall`:

- `sync`: the raw export `Module._sqlite3_step(stmt)`, always a number.
- `async`: `Module.ccall('sqlite3_step', 'number', ['number'], [stmt])` **without** the `async` option. It records `Asyncify.currData` before the call and, if it changed (the call unwound), returns `Asyncify.whenDone().then(onDone)`; otherwise the number.
- `jspi`: the `promising` export `Module._sqlite3_step(stmt)`, always a promise.

The prototype that produced the table above (a worker on wa-sqlite alone) implemented exactly this; its shape, for reference:

```js
const fastStep = (s) => {
  if (module.retryOps.length) return slow(s, 0);
  const r = call(s);
  return typeof r === 'number' ? after(r, s, 0) : r.then((rc) => after(rc, s, 0));
};
// after(rc, s, k): if rc === OK or no retryOps → (pendingOps ? await them, then check : check(rc));
//                  else k === 0 ? slow(s, 1) : check(rc)
// slow(s, k): await retryOps (finally empty), rc = await call(s), return after(rc, s, k)
```

## Where it applies

- **`run()`'s row loop**: the call site changes from `result = await sqlite.step(stmt)` to taking the fast step's return and awaiting it only when it is a promise. The `stepping` flag, the `SQLITE_INTERRUPT` break and `stamped()` stay as they are around it.
- **The pragma loop in `open`** (`while ((await sqlite.step(stmt)) === SQLITE_ROW) {}`) takes the fast step too (user, 2026-10-16). It gains nothing measurable, but one step path in the worker is simpler to read, and open is where `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` meet contention most: a pragma there can take `SQLITE_BUSY` with `retryOps` queued, so the existing contention-at-open tests exercise the fast step's retry path for free. Everything it needs (module, build, database) exists by then.
- The library's progress handler on `async`/`jspi` is an `async` function (`gate.tick()`), so a long statement suspends every `PROGRESS_OPS` operations on those builds: those steps return a promise and take the asynchronous path. This is expected and must work; it is also why a long read is a good behavioural test of the `async` path even on `MemoryVFS`.

Where the code lives (its own module under `src/worker/`, a factory taking the module, the build and the database) is left to the builder.

## Guarding the repin

Two protections, both required (user, 2026-10-16): if the procedure is followed, the fast step is already updated when the test runs; if it is not, the test stops an out-of-date fast step reaching the library.

1. **The procedure.** `mem:stack-and-build/wa-sqlite` gains a repin step: compare, between the old pin and the new, everything listed in "What the fast step reproduces" and the code that fills `retryOps`/`pendingOps`; update the fast step if anything moved.
2. **A unit test that reads the code instead of running it.** In the unit project (runs on every commit), it reads the installed wa-sqlite sources (`node_modules/wa-sqlite`, patch applied), extracts each reproduced fragment, and compares a fingerprint of each to a value recorded in the test. Fragments:
   - in `src/sqlite-api.js`: `sqlite3.step`, `check`, `retry`, and the initialisation of `Module.retryOps`/`Module.pendingOps` in `Factory`;
   - in each build's glue (`dist/wa-sqlite.mjs`, `dist/wa-sqlite-async.mjs`, `dist/wa-sqlite-jspi.mjs`): `ccall`, and for `jspi` whatever makes `_sqlite3_step` a `promising` export;
   - every statement in `src/` that touches `retryOps` or `pendingOps` (today `sqlite-api.js`, `OPFSCoopSyncVFS.js`, `OPFSWriteAheadVFS.js`).

   A mismatch fails with the fragment's name and what to re-read; the fix is to review the fast step against the new code and update the recorded value in the same commit. A fragment the test can no longer find fails the same way. Whitespace normalisation, the hash, and how fragments are extracted are the builder's.

   Known consequence: when #381 leaves the patch at a repin (merged upstream), the `OPFSCoopSyncVFS` fragment may change and trip the test. That is the test doing its job.

## Tests

- **The fast step's logic, in the unit project**, against a fake module: number returned, promise returned, `retryOps` queued before the call, queued by the call with a non-OK code (one retry, then the code), queued with `SQLITE_OK`, `pendingOps` resolving and rejecting (with and without `code`), an error code producing `SQLiteError` with `sqlite3_errmsg`'s text.
- **In the browser suite**, on every build: a long read whose row count is exact (the progress handler makes `async`/`jspi` suspend mid-statement); an error raised by a step (constraint, or a runtime error) arriving with the same message, `code` and `extendedCode` as before; abort mid-read still ending on `SQLITE_INTERRUPT` handling. The existing suite already covers much of this; the builder adds what is missing and says which existing tests cover the rest. `OPFSCoopSyncVFS`'s `SQLITE_BUSY` → `retryOps` path must be exercised by at least one test that goes through the fast step (contention between two connections).
- **The fingerprint test** above.
- The usual delivery gate (`node scripts/hook-gate.ts delivery --run`), and the matrix on GitHub before the merge — the branch touches `src/worker/` (`mem:conventions`, § What runs where).

## Measurements — agreed with the user, 2026-10-16

Before and after, on the same machine, the two builds of the library interleaved, n≥3:

- **The studied case**: `chunk()` and `stream()` on 4 000 000 rows of two integers, `MemoryVFS`, on `sync`, `async` and `jspi`, on Chromium and on a **stock** Firefox through the direct harness (Playwright's Firefox inflates every `await`, FF-PW-AWAIT in `mem:measurements/footprint`).
- **The other VFS**: the same scenario on each VFS on its default build, to confirm the gain holds and nothing regresses where the VFS really suspends.
- **A one-row query**, to show the fast step costs nothing where it cannot gain.
- **The existing bench**: `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chrome --all` stays `OK`.

**How (designer's call, from what the container holds).** The direct harness of earlier campaigns (BINARY-PROTOCOL, `mem:measurements/binary-protocol`: browsers launched by hand, no Playwright, no WebDriver, page served with COOP/COEP) was kept outside the repo and is not available; rebuild it under `.scratchpad/` (`mem:conventions`). The stock binaries are the ones `scripts/browsers.ts` installs under `node_modules/.cache/wdio/` — Chrome for Testing and Mozilla's Firefox releases (`firefox/linux_arm-stable_<version>/firefox/firefox`); use the pinned pair (Chrome 153, Firefox 155.0.1). Both builds of the library (`main` and the branch) are served side by side so one page alternates them per run. The measurement task is the agent's, not the user's.

Results go to `mem:measurements` (with an ID), the conclusion to `mem:follow-ups/wa-step`.

## Deliverables beyond the code

- `CHANGELOG.md`, `[Unreleased]`: one line under Changed — reading rows is faster, most on Firefox. No figures (`mem:conventions`).
- `mem:stack-and-build/wa-sqlite`: the repin step.
- `mem:follow-ups/wa-step`: the library side done; its "control-statement loop" corrected (the second call site is the pragma loop in `open`); what remains is the upstream discussion, presenting the two upstream options (`step()` kept `async` without the nested `retry()`; a synchronous-when-possible method beside `step()`), noting that changing `step()`'s return type is breaking and so a major version under semver (user, 2026-10-16).

## Left to the builder

The module layout and names, how the call site avoids an `await` on a number, the fingerprint's extraction and hash, the harness changes needed for the measurements, and which existing browser tests count as coverage.
