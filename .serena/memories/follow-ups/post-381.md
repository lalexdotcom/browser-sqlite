# Follow-up — post #381: `openWithRetry`'s first-open retry serves no VFS any more

Part of `mem:follow-ups`. Investigated 2026-10-23 (user: "marquer le résultat en follow-up post #381"), on the branch of the repin to `6b59b231`, with #381 (`42bfb903`) and #386 carried in the patch. Not acted on: the user decides whether to clean now or after #381 merges.

**What is redundant.** `openWithRetry` (`src/worker/worker.ts`) retries `sqlite3_open_v2` on a first open (`afterDeath === undefined`) for the VFS that declare `exclusiveFileHandle: true` (`src/const/vfs.ts`): `OPFSCoopSyncVFS` and `AccessHandlePoolVFS`.
- **`OPFSCoopSyncVFS`:** `jOpen()` takes its handles through `#requestAccessHandle()`, which with #381 retries a held file for 5 s (`HELD_RETRY_TIMEOUT`) with the Web Lock kept. The library's budget, `OPEN_RETRY_BUDGET_MS`, is 2.5 s from the call: the first held failure arrives after ≥ 5 s, past the deadline, so the loop never makes a second attempt. The `idle` after-death budget is the same 2.5 s, dead too for this VFS (read, not run: `open-retry`'s after-death tests are tagged `vfs:OPFSAdaptiveVFS`).
- **`AccessHandlePoolVFS`:** its `jOpen()` is synchronous and touches no OPFS (a pool file already open), and the VFS has no `lastError`, so `isHeldElsewhere(lastError())` is always false: the loop gives up at the first failure. It never served this VFS; its held files are `createVfsInstance`'s.

**Measured (this container, Chrome 153, Firefox 155).**

| arm | `open-retry` › "succeeds once the holder lets go" (4 cells: chrome/firefox × not-isolated/isolated, `OPFSCoopSyncVFS/sync`) |
|---|---|
| first-open retry off for `OPFSCoopSyncVFS`, #381 in | green 4/4 |
| retry off and #381 out (installed file = `6b59b231` + #386 only) | red 4/4: `WORKER_CRASHED`, `NoModificationAllowedError` on `createSyncAccessHandle` |

And the whole first-open branch removed (`if (afterDeath === undefined) return open_v2`) on every pair of both VFS (`sync`/`jspi`/`async`), Chrome and Firefox, `--full`: 39 cells, 1 534/1 534 files, 8 644 tests passed. So no test depends on it while #381 is carried — and `open-retry`'s holder test is the guard that goes red if #381 ever leaves the patch without the retry coming back.

**What stays.** The after-death retry: the `busy` case waits until `openDeadline` (up to ~29 s) for a statement Safari cannot stop (WebKit 328618), far past #381's 5 s — unmeasured here, no Safari; and on `OPFSAdaptiveVFS` an `xOpen` without `readwrite-unsafe`, which #382 (in `jLock()`) does not cover. `createVfsInstance`'s retry: no longer reached by `OPFSCoopSyncVFS` once #386 is carried, still `AccessHandlePoolVFS`'s, generic — nothing to remove.

**A cleanup would touch:** the first-open branch of `openWithRetry` (then `exclusiveFileHandle` is read only by the test planner's `requires:exclusive-file-handle`, `tests/harness/planner/need.ts`, used by `open-retry`'s "fails without waiting out the retry budget"); the comments justifying it (`worker.ts` above `openWithRetry`, `vfs.ts` on `exclusiveFileHandle`); `open-retry.test.ts`'s header, which says it pins the library's retry. **#381 merged on 2026-10-23 (`8a8bc2ee`) and is pinned**, so the risk of it leaving the patch is gone; the cleanup is the user's next step (2026-10-23).
