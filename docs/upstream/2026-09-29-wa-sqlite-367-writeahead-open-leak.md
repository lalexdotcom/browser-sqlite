# wa-sqlite #367 — a write-ahead file left open by a failed open

*2026-09-28/29 — measured on Chromium 151 and Firefox, in the container*

[pr367]: https://github.com/rhashimoto/wa-sqlite/pull/367
[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365
[pr350]: 2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md

**Why this is here.** `OPFSWriteAheadVFS` is one of the two VFS this library recommends. When opening a database fails at the wrong moment, it keeps one of its two write-ahead files open for the life of the worker. On Firefox that handle is exclusive, so every later open of the database fails until the worker is replaced. It is the class of leak [#350][pr350] fixed in `OPFSCoopSyncVFS`, in a VFS that had not been checked for it. Carried in [`patches/`](../../patches) since 2026-09-29; measured since, this library is not exposed to it (below).

## How it was found

The maintainer asked, on [#365][pr365], whether `OPFSWriteAheadVFS` has the retry problems we had found in `OPFSCoopSyncVFS`. Reading `#retryOpen` for both: the cause of a failed open is kept (`retryResult`, then `lastError`), so [#357](2026-09-21-wa-sqlite-357-coopsync-open-last-error.md)'s problem does not arise. [#350][pr350]'s does.

## The mechanism

`#retryOpen` opens the main file, then the two write-ahead files together:

```js
const waHandles = await Promise.all([0, 1].map(async i => {
  const waHandle = await openFile(waName, { create: true });
  …
}));
```

`openFile` pushes the file's cleanup onto `onError` only once `createSyncAccessHandle` has resolved. When one of the two rejects while the other is still in flight, `Promise.all` rejects at once and the `catch` runs `onError`. The other acquisition completes a moment later and pushes a cleanup nothing will run: its handle stays open, and on a new database the file is left behind, since the cleanup is also what removes it.

## Reproduced

A directory named `<db>-wa0` makes the first write-ahead file's `getFileHandle` reject at once (`TypeMismatchError`), while `-wa1` is still being acquired. After the failed open, an exclusive handle is tried on each file. 5 of 5 on the default and asyncify builds: the main file closed and removed, `-wa1` present and held — `NoModificationAllowedError`.

What that costs was then measured, not assumed: Playwright with persistent profiles, 2 runs per case, a write, a close and a read from a fresh worker after every reopen that succeeded.

| reopen after the failed open | Chromium | Firefox | both, `Promise.allSettled` |
| --- | --- | --- | --- |
| same worker | ok | **fails, `NoModificationAllowedError`** | ok |
| another worker, the leaking one alive | ok | **fails, `NoModificationAllowedError`** | ok |
| another worker, the leaking one terminated | ok | ok | ok |

Chromium's `readwrite-unsafe` handles coexist, so there the leak costs a handle and an orphaned file. Firefox has no `readwrite-unsafe`: the leaked handle is exclusive and blocks the database. Probes in `.work/worst/leak/`, runner `.scratchpad/365-lib-arms/reopen-runner.mjs`.

## The change and its test

`Promise.allSettled`, then rethrow the first rejection: both acquisitions have finished when the failure is reported, so the cleanup sees every handle. Same behaviour on success, same error on failure.

`test/vfs_open_cleanup.js`, in `OPFSWriteAheadVFS.test.js`, reuses the sabotage and asks for an exclusive handle on `-wa1` after the failed open. The suite runs Chromium only, where the reopen cannot show the leak; the handle can. `vfs_handle_recovery.js`, #350's test, now exports its holder for this.

| | default | asyncify | jspi |
| --- | --- | --- | --- |
| `master` | `Expected 'NoModificationAllowedError' to be 'free'` | same | same |
| with the change | 114 tests of the file pass, 3 runs of 3 | | |

The whole suite on the branch, `master` merged in: 5836 passed, 0 failed.

## Posted upstream

PR [#367][pr367], opened 2026-09-29 from `lalexdotcom:fix/writeahead-open-leak`. Two commits, the fix then the test, cut from `master` at `e6e01ae1`; `master` (#365's merge) was then merged in, resolving the one conflict — both PRs add a test to `OPFSWriteAheadVFS.test.js` — and the measurements above were retaken after it. Upstream CI on the head commit is green — [run 36527078842](https://github.com/rhashimoto/wa-sqlite/actions/runs/36527078842), `build (20.x)`, the only check.

It does not mention this library, per the standing rule.

## What stays ours

- **No exposure here, measured 2026-09-30.** This library does not retry this VFS's open inside a worker: a worker whose open fails is terminated, and the handle it kept goes with it. With the fix reversed, on Firefox, a client opened after the failed one was closed succeeded 30 times of 30, whichever of the database file, `-wa0` and `-wa1` was held (`mem:measurements`, LEAK-LIB). What would make one write-ahead file fail and not the other in practice is not established — the sabotage is artificial.
- **The siblings.** The same question found the class in `AccessHandlePoolVFS` (both engines) and `OPFSAdaptiveVFS`'s open lock (Firefox); both are reproduced, fixed and tested, and opened as [#368](2026-09-29-wa-sqlite-368-ahp-acquire-leak.md) and [#369](2026-09-29-wa-sqlite-369-adaptive-open-lock.md). `OPFSCoopSyncVFS`'s `#initialize()` has the pattern by reading; forced on 2026-09-30, it blocks nothing (`mem:measurements`, LEAK-LIB).
