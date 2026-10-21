# A stranded IndexedDB connection on Safari 26 — diagnosed and measured through the library 2026-10-20; two fixes measured, the user decides

Part of `mem:follow-ups`. Comes before `mem:follow-ups/safari-suite` (user, 2026-10-20). Numbers: SAFARI-IDB-STRAND (raw IndexedDB, conformance, cost) and SAFARI-IDB-LIB (the pair suite, forced kills, the quiesce) in `mem:measurements/test-browsers`.

## Diagnosis

- **Safari's defect, WebKit 324094** (fixed by 321564@main, in Safari Technology Preview 254 of 2026-10-08, with follow-ups 323066@main and WebKit 327323; absent from 26.6.2 and from 27.0.1 as measured; Safari 27 is stable, and a later 27.x — 27.1, or 27.2 in beta — may carry the fix: not verified, the `xcode-27` run would settle it). A worker ended (`terminate()` or `self.close()`) before its last IndexedDB transaction fired `complete` — a readonly one included — leaves its connection open on the server. The database stays usable, but `deleteDatabase` and upgrades block, through reloads. With a readwrite and a readonly transaction in flight at once (raw harness only) it is **wedged**: no transaction completes. STP 27.0 on the same image: clean in every case.
- **Through the library, three triggers.** (1) The delete worker — the `jAccess` barrier's readonly transaction still live at its `deleted` reply, the client terminating at once (`src/delete.ts`); every test cleanup on an IndexedDB VFS goes through it, hence 45 of 75 pair files stranding on `IDBBatchAtomicVFS`. (2) The pool's `close` — a `closed` reply carrying a live transaction, rare on `IDBBatchAtomicVFS`, at open already on `IDBMirrorVFS`. (3) Forced kills (`handleDeath`, `failClient`, drain timeout) of a worker with IndexedDB work in flight: ~3 % of kills mid-write on `IDBBatchAtomicVFS`, ~22 % on `IDBMirrorVFS`; in the suite, `lifecycle`'s kill right after `ready`. Every stranding through the library was a held connection with the database still usable — no wedge seen (15/15).
- **Consumer impact:** the library keeps working on a stranded store (its `deleteDatabase` deletes records); what breaks is `indexedDB.deleteDatabase` and any IndexedDB upgrade of that database, for the life of the Safari process. On `IDBBatchAtomicVFS` the one IndexedDB database holds every SQLite database of the origin.

## Two fixes, prototyped on `spike/safari` (not on `main`)

1. **Settle before the last reply** — `src/worker/idb-settle.ts` tracks each transaction until `complete`/`abort` (not `error`); the worker awaits them, bounded at 2 s, before `closed` and `deleted`. Removes (1) and (2): pair suite 0/75 on both VFS, conformance 0/41. No cost detectable per transaction; ≤ 2 ms per reply.
2. **Quiesce before a forced kill** — the pool's `terminate()` (except after a `closed`) posts `quiesce`, kills on `quiesced` or after a 300 ms grace; the worker refuses new transactions and waits for the live ones (bounded 1 s). Removes (3): 0 in 800 kills against 7/230 and 10/45 with (1) alone; pair suite with both 0/75 on both VFS, Chrome 150/150. Cost: none on ordinary paths; a forced kill reaches the engine up to the grace later. A worker that never answers is killed as today.
3. Rejected: an empty readwrite barrier (`close()` ×150 on `IDBBatchAtomicVFS`).

## For the user to decide

- Ship (1), and (2) or not: (2) changes when a dead worker's thread actually stops, on the failure paths only. Covering every reply before a `terminate()` (`not-found` and the delete path's `error` too). Gate by storage (IndexedDB VFS only) or for all — measured only on the IndexedDB VFS.
- Tests: unit tests for the tracker and the quiesce protocol; a browser test shows the defect only on Safari 26/27.0.x.
- Upstream: `IDBBatchAtomicVFS.close()` closes without awaiting `#txComplete` — optional, the library-side wait covers it.

## Not IndexedDB, found on the way (for `mem:follow-ups/safari-suite`)

- `default-build.test.ts` "falls back to the first declared build that requires nothing": its premise asserts JSPI on every engine; Safari 26 has none.
- `lifecycle.test.ts` "fails the client permanently once the restart budget is spent": the replacement is not ready within the test's 5 s on Safari (8 of 20, 3 of 9 runs).

## Later (user, 2026-10-20)

- A run on Safari 27 (the `xcode-27` image, macOS 27): "à voir après".
- Rename the macOS tests/workflows to "macOS 26".

## The spike branch

`spike/safari` on origin: `spike/idb/` (raw harness; plans `variants`, `stranded`, `check:*`, `wedge`, `barrier`, `core`, `bench`), `tests/browser/setup/spike-idb-trace.ts` (registered after the wipe and before the guard), `tests/browser/conformance/spike-perf.test.ts`, `tests/browser/pairs/spike-kill.test.ts`, `src/worker/idb-settle.ts`, the quiesce in `src/pool.ts` and `src/worker/worker.ts`, and `.github/workflows/spike-safari.yaml`, whose jobs run when the commit message carries their tag (`[micro]`, `[suite]`, `[locate]`, `[ab]`, `[perf]`, `[stp]`, `[pairs]`, `[forced]`, `[lifeloc]`, `[kill]`). Worker modes by name suffix: `[trace]`, `[fix]`, `[barrier]`, none (`VITE_SPIKE_BARE=1`); `VITE_SPIKE_QUIESCE=<ms>`, `VITE_SPIKE_PROBE=1`. Its commit d505ede also carries, by mistake, the memory edits of 2026-10-20 (copied back to `main`'s working tree). A push runs the pre-push `pnpm test` (src changed). Delete the branch (local and origin) when the work is over.
