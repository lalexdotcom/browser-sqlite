# A stranded IndexedDB connection on Safari — fixed, through wa-sqlite #384/#385 carried (merged 2026-10-21)

Part of `mem:follow-ups`. Comes before `mem:follow-ups/safari-suite` (user, 2026-10-20). Numbers: SAFARI-IDB-STRAND (raw IndexedDB, conformance, cost) and SAFARI-IDB-LIB (the pair suite, forced kills, the quiesce, the validation) in `mem:measurements/test-browsers`; IDB-CLOSE-384 (the upstream side) in `mem:measurements/wa-sqlite-prs`.

## Diagnosis

- **Safari's defect, WebKit 324094** (fixed by 321564@main, in Safari Technology Preview 254 of 2026-10-08, with follow-ups 323066@main and WebKit 327323; absent from 26.6.2 and from 27.0.1 as measured; a later 27.x may carry the fix: not verified, the `xcode-27` run would settle it). A worker ended (`terminate()` or `self.close()`) before its last IndexedDB transaction fired `complete` — a readonly one included — leaves its connection open on the server: `indexedDB.deleteDatabase` and upgrades block, through reloads. With a readwrite and a readonly transaction in flight at once (raw harness only) the database is **wedged**. STP 27.0: clean.
- **Through the library, three triggers:** the delete worker (the `jAccess` barrier's readonly transaction live at its `deleted` reply — every IndexedDB test cleanup, 45/75 pair files on `IDBBatchAtomicVFS`), the pool's `close` (a `closed` reply carrying a live transaction; at open already on `IDBMirrorVFS`), and forced kills (`handleDeath`, `failClient`, drain timeout) mid-write (~3 % of kills on `IDBBatchAtomicVFS`, ~22 % on `IDBMirrorVFS`). Through the library the database stayed usable every time (15/15): what breaks is `indexedDB.deleteDatabase` and IndexedDB upgrades, for the life of the Safari process.
- **Beside it, on every engine:** wa-sqlite's `IDBBatchAtomicVFS` under `synchronous=NORMAL` has its last commit in flight when `close()` returns, lost when the worker is terminated (#384). rc.10's close path lost it; the library's first fix hid it; CHANGELOG Fixed entry added 2026-10-21.

## The fix as it stands (branch `fix/idb-vfs-close`, user's go 2026-10-21: `vfs.close()` everywhere)

- **wa-sqlite #384 and #385** (reports in `docs/upstream/`, `mem:upstream`) make the IndexedDB VFS's `close()` close the connection and wait for every transaction it started; carried in `patches/` beside #381/#382. What the library relies on in them, and what a review could break: `mem:stack-and-build/wa-sqlite` § The patch.
- `src/worker/worker.ts` `closeIdbVfs` (IndexedDB storage only, bounded `IDB_CLOSE_MS` 2 s): before the `closed` reply and on `quiesce` (the closed connection refuses new transactions). `deleteDatabaseFiles` closes its VFS on every outcome, its probe's error path included.
- Protocol `quiesce` / `quiesced`, unchanged since `fix/safari-idb-stranded`: `src/pool.ts` `terminate()`, on an IndexedDB VFS and unless the worker had answered `closed` (status read before `poison()`), cuts the transport, detaches `onmessage`, posts `quiesce` and calls the engine's terminate on `quiesced` or after `QUIESCE_GRACE_MS` (300 ms); other VFS terminate at once (an OPFS handle must not outlive the kill while a replacement opens). `tests/browser/pairs/quiesce.test.ts` (a request dropped on its way stands for a worker that cannot answer — Safari does not deliver an `ErrorEvent` dispatched on a Worker already terminated).
- **Gone:** `src/worker/idb-transactions.ts` (the worker's patch of `IDBDatabase.prototype.transaction`, `settled`, `refuseNew`) and its unit test; at `f4a07b3` if needed again.
- `tests/browser/pairs/close.test.ts` "keeps the last write of a client closed under synchronous=NORMAL" (red without `closeIdbVfs` on the 4 `IDBBatchAtomicVFS` pairs, Chrome and Firefox).
- Kept from `fix/safari-idb-stranded`: planner property `jspi-available`, `default-build`'s fallback test tagged `requires:jspi-available`.
- CHANGELOG `[Unreleased]` › Fixed: the two Safari entries (still true) and the `synchronous=NORMAL` one — which leaves at the repin that brings #384 (`mem:conventions/upstream`).
- Local, 2026-10-21: `pnpm test` 366/366 files, 2719 passed, not-applicable 20/14/11/5, reasoned skips only `abandon-gc`; `tsc`, lint, `biome ci` clean. Safari 26.6.2, spike run 39590341646 (`[pairs] [kill] [one]`): 0 stranded in 77 pair files and 0 in 400 kills per VFS (IDB-CLOSE-384, `mem:measurements/wa-sqlite-prs`). Merged into `main` 2026-10-21 (user: "si tout est validé par les runs on clôture").

## Left

- `spike/safari` was deleted on 2026-10-23 (local, origin, its worktree; user): the Safari suite it might have served is merged and green on Safari 26 and 27.
- Follow #384 and #385; at their merge, repin and drop their hunks from the patch.
- Not covered: a worker that never answers stays alive up to 300 ms after a forced kill; a forced kill of a worker inside one long computing step still strands if it had a transaction live (not measured).
- For `mem:follow-ups/safari-suite`: `lifecycle.test.ts` "fails the client permanently once the restart budget is spent" times out its 5 s wait for the replacement on Safari (8/20, 3/9, 2/6 runs).

## Later (user, 2026-10-20)

- A run on Safari 27 (the `xcode-27` image, macOS 27): "à voir après". The CHANGELOG entries say "On Safari" with no version (user, 2026-10-21: earlier versions have it too — WebKit 324094's reporter wedged iOS 18.3.2); 27.0.1 still has it, wedge included (re-measured on the user's Mac 2026-10-21, SAFARI-IDB-STRAND).
- Keep or remove the fix (user's question, 2026-10-21): cost measured negligible, so it can stay indefinitely; removing it needs a minimum Safari that carries 321564@main (a 27.x after 27.0.1, to measure), not "Safari ≥ 27". #384 stays needed regardless.
- Rename the macOS tests/workflows to "macOS 26".

## The spike branch

`spike/safari` held, until its deletion on 2026-10-23, the reproducers (`spike/idb/`, `tests/browser/setup/spike-idb-trace.ts` registered after the wipe and before the guard, `tests/browser/conformance/spike-perf.test.ts`, `tests/browser/pairs/spike-kill.test.ts`) and `.github/workflows/spike-safari.yaml`, whose jobs run when the commit message carries their tag (`[micro]`, `[suite]`, `[locate]`, `[ab]`, `[perf]`, `[stp]`, `[pairs]`, `[forced]`, `[lifeloc]`, `[kill]`, `[one]`). It has `fix/safari-idb-stranded` and then `fix/idb-vfs-close` merged in (worktree `.work/spike-safari-wt`); the trace's `idbPending` field is empty since the tracker went — the storage wipe's "still open" and `SPIKE-KILL` lines are the signal. A push runs the pre-push `pnpm test`. Delete it when the work is over.
