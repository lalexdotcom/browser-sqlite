# A stranded IndexedDB connection on Safari 26 — fixed on `fix/safari-idb-stranded` (2026-10-21), validated on Safari, not merged

Part of `mem:follow-ups`. Comes before `mem:follow-ups/safari-suite` (user, 2026-10-20). Numbers: SAFARI-IDB-STRAND (raw IndexedDB, conformance, cost) and SAFARI-IDB-LIB (the pair suite, forced kills, the quiesce, the validation) in `mem:measurements/test-browsers`.

## Diagnosis

- **Safari's defect, WebKit 324094** (fixed by 321564@main, in Safari Technology Preview 254 of 2026-10-08, with follow-ups 323066@main and WebKit 327323; absent from 26.6.2 and from 27.0.1 as measured; Safari 27 is stable, and a later 27.x — 27.1, or 27.2 in beta — may carry the fix: not verified, the `xcode-27` run would settle it). A worker ended (`terminate()` or `self.close()`) before its last IndexedDB transaction fired `complete` — a readonly one included — leaves its connection open on the server: `indexedDB.deleteDatabase` and upgrades block, through reloads. With a readwrite and a readonly transaction in flight at once (raw harness only) the database is **wedged**. STP 27.0: clean.
- **Through the library, three triggers:** the delete worker (the `jAccess` barrier's readonly transaction live at its `deleted` reply — every IndexedDB test cleanup, 45/75 pair files on `IDBBatchAtomicVFS`), the pool's `close` (a `closed` reply carrying a live transaction; at open already on `IDBMirrorVFS`), and forced kills (`handleDeath`, `failClient`, drain timeout) mid-write (~3 % of kills on `IDBBatchAtomicVFS`, ~22 % on `IDBMirrorVFS`). Through the library the database stayed usable every time (15/15): what breaks is `indexedDB.deleteDatabase` and IndexedDB upgrades, for the life of the Safari process.

## The fix (branch `fix/safari-idb-stranded`, user's go 2026-10-21)

- `src/worker/idb-transactions.ts` (`trackIdbTransactions`, unit tests `tests/unit/lib/idb-transactions.test.ts`): the worker wraps `IDBDatabase.prototype.transaction` at load and tracks each transaction until `complete`/`abort` (not `error`); `settled(ms)` waits until none is live (again after each wait), `refuseNew()` makes later ones throw `InvalidStateError`.
- The worker awaits it (bounded `IDB_SETTLE_MS` 2 s) before `closed` and before every reply of the delete worker (`deleted`, `not-found`, `error` — `.finally(idbSettled)`).
- Protocol `quiesce` / `quiesced`. `src/pool.ts` `terminate()`: on an IndexedDB VFS (`VFS_CAPABILITIES[vfs].storage`), unless the worker had answered `closed` (status read before `poison()`), cuts the transport, detaches `onmessage`, posts `quiesce` and calls the engine's terminate on `quiesced` or after `QUIESCE_GRACE_MS` (300 ms); other VFS terminate at once (an OPFS handle must not outlive the kill while a replacement opens). Browser tests `tests/browser/pairs/quiesce.test.ts` (a request dropped on its way stands for a worker that cannot answer — Safari does not deliver an `ErrorEvent` dispatched on a Worker already terminated, so `killSilently` + crash does not work there).
- Planner property `jspi-available` (the engine's `jspi` feature) and `default-build`'s fallback test tagged `requires:jspi-available`.
- CHANGELOG `[Unreleased]` › Fixed: two entries.
- Local: `pnpm test` 365/365 files, not-applicable counts unchanged (20/14/11/5), `tsc`, lint, `biome ci` clean. Safari 26.6.2 (spike runs 39569148800, 39574613092): pairs 0 stranded on both VFS, conformance 24/24, kill stress 0/400 per VFS, `quiesce` 6/6.

## Left

- Merge into `main` (user), then delete `spike/safari` local and origin.
- Not covered: a worker that never answers stays alive up to 300 ms after a forced kill; a forced kill of a worker inside one long computing step still strands if it had a transaction live (not measured).
- **Propose a PR upstream (user, 2026-10-21):** wa-sqlite's IndexedDB VFS close without awaiting their live transactions (`IDBBatchAtomicVFS.close()` skips `#txComplete`; `IDBMirrorVFS` keeps commits in flight). A `close()` that settles them would let the library drop its patch of `IDBDatabase.prototype.transaction` in the worker (`src/worker/idb-transactions.ts`) for the close path; the forced-kill quiesce still needs the refusal of new transactions. Follow `mem:conventions/upstream`.
- For `mem:follow-ups/safari-suite`: `lifecycle.test.ts` "fails the client permanently once the restart budget is spent" times out its 5 s wait for the replacement on Safari (8/20, 3/9, 2/6 runs).

## Later (user, 2026-10-20)

- A run on Safari 27 (the `xcode-27` image, macOS 27): "à voir après". The CHANGELOG entries say "On Safari" with no version (user, 2026-10-21: earlier versions have it too — WebKit 324094's reporter wedged iOS 18.3.2); 27.0.1 still has it, wedge included (re-measured on the user's Mac 2026-10-21, SAFARI-IDB-STRAND).
- Keep or remove the fix (user's question, 2026-10-21): cost measured negligible, so it can stay indefinitely; removing it needs a minimum Safari that carries 321564@main (a 27.x after 27.0.1, to measure), not "Safari ≥ 27".
- Rename the macOS tests/workflows to "macOS 26".

## The spike branch

`spike/safari` on origin: the reproducers (`spike/idb/`, `tests/browser/setup/spike-idb-trace.ts` registered after the wipe and before the guard, `tests/browser/conformance/spike-perf.test.ts`, `tests/browser/pairs/spike-kill.test.ts`) and `.github/workflows/spike-safari.yaml`, whose jobs run when the commit message carries their tag (`[micro]`, `[suite]`, `[locate]`, `[ab]`, `[perf]`, `[stp]`, `[pairs]`, `[forced]`, `[lifeloc]`, `[kill]`, `[one]`). It has `fix/safari-idb-stranded` merged in (the prototype `src/worker/idb-settle.ts` removed). A push runs the pre-push `pnpm test`. Delete it when the work is over.
