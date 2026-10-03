# wa-sqlite #368 — a pool that one failed creation blocks for good

*2026-09-28/29 — measured on Chromium 151 and Firefox, in the container*

[pr368]: https://github.com/rhashimoto/wa-sqlite/pull/368
[pr365]: https://github.com/rhashimoto/wa-sqlite/pull/365
[pr350]: 2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md

**Why this is here.** `AccessHandlePoolVFS` takes every file of its pool exclusively when it is created. If one of them is held elsewhere at that moment, the creation fails — as it should — but keeps the handles it did acquire, and from then on every creation on that pool fails, in any worker, until the worker that failed is terminated. This library's `createVfsInstance` retries `create()` in the same worker for 10 s, precisely to wait out a worker that has just died and still holds the files. It is [#350][pr350]'s class of leak again. Carried in [`patches/`](../../patches) since 2026-09-29, and guarded here by a test since 2026-09-30 (below).

## How it was found

Checking the other VFS for #350's pattern, after the maintainer asked on [#365][pr365] whether `OPFSWriteAheadVFS` had it ([#367](2026-09-29-wa-sqlite-367-writeahead-open-leak.md)).

## The mechanism

```js
await Promise.all(files.map(async ([name, handle]) => {
  const accessHandle = await handle.createSyncAccessHandle();
  this.#mapAccessHandleToName.set(accessHandle, name);
  …
}));
```

Nothing catches a rejection here or in `isReady()`. When one acquisition fails, the ones that succeeded before or complete after are registered in the maps of an instance that `create()` then abandons; nobody closes them. Pool handles are exclusive on every engine, so the next `create()`, in the same worker or another, fails on those files.

## Reproduced

A worker creates a pool and closes it; a holder takes an exclusive handle on one pool file; another worker's `create()` fails with `NoModificationAllowedError`, as expected. The holder lets go. Playwright with persistent profiles, 2 runs per case:

| after the failed `create()` | Chromium, `master` | Firefox, `master` | both, with the change |
| --- | --- | --- | --- |
| `create()` in another worker | fails, `NoModificationAllowedError` | fails, same | ok |
| `create()` again in the same worker | fails, same | fails, same | ok |
| after the failing worker terminates | ok | ok | ok |

Probes in `.work/worst/leak/`, runner `.scratchpad/365-lib-arms/ahp-runner.mjs`.

## The change and its test

`Promise.allSettled`; if any acquisition failed, `#releaseAccessHandles()` closes what was acquired and the first rejection is rethrown.

`test/vfs_pool_recovery.js`, in `AccessHandlePoolVFS.test.js`, with a worker of its own: `TestContext.create()` never settles when the VFS fails to start, so the test cannot go through the harness. Holder, failed creation, release, then a second `create()` in the same worker.

| | default | asyncify | jspi |
| --- | --- | --- | --- |
| `master` | `Expected 'NoModificationAllowedError' to be 'created'` | same | same |
| with the change | 108 tests of the file pass, 3 runs of 3 | | |

The whole suite on the branch: 5797 passed, 0 failed.

## Posted upstream

PR [#368][pr368], opened 2026-09-29 from `lalexdotcom:fix/ahp-acquire-leak`. Two commits, the fix then the test, cut from `master` at `e6e01ae1`; `master` has moved one commit since (#365), touching none of its files, and the branch merges cleanly. Upstream CI on the head commit is green — [run 36528697359](https://github.com/rhashimoto/wa-sqlite/actions/runs/36528697359), `build (20.x)`, the only check.

It does not mention this library, per the standing rule.

## What stays ours

- **The exposure, measured 2026-09-30.** `createVfsInstance` (`src/worker/worker.ts`) retries `create()` in one worker to wait for a dying worker's handles. With one pool file held at the first attempt and released after it, the open succeeds with the fix; without it every retry fails on the handles the first attempt kept, and the open gives up after the 10 s, on both engines (`mem:measurements`, LEAK-LIB). `tests/browser/vfs-create-retry.test.ts` guards it. What would hold part of a pool in practice is a dying worker releasing its handles one by one: Firefox does, within 6 ms (21 under load), Chromium releases them at once. The replacement worker never arrived inside that window — with the fix reversed, the read after a killed worker answered 100 times of 100.
- **The last sibling.** `OPFSAdaptiveVFS`'s open lock (Firefox) is [#369](2026-09-29-wa-sqlite-369-adaptive-open-lock.md).

## Merged

**Merged on 2026-10-02** by rhashimoto, as `5bde491c` on `master`, its `AccessHandlePoolVFS.js` byte for byte the head the patch carried. It left [`patches/`](../../patches) at the repin of 2026-10-03 to `7fcc30df`.
