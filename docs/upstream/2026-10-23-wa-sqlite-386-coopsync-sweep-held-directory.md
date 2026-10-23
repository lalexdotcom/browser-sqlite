# wa-sqlite #386 — `OPFSCoopSyncVFS.create()` fails on a temporary directory whose files are still open

*2026-10-23 — measured on Chrome 153 and Firefox 155, in the container*

[pr386]: https://github.com/rhashimoto/wa-sqlite/pull/386
[issue362]: https://github.com/rhashimoto/wa-sqlite/issues/362

**Why this is here.** `OPFSCoopSyncVFS`'s `#initialize()` deletes every `.ahp-*` directory whose Web Lock it can get. A worker that goes away without closing its access handles can have that lock released before its handles are closed; the next instance's sweep then gets the lock, `removeEntry()` throws `NoModificationAllowedError`, and `create()` fails. Only `NotFoundError` was tolerated there (#347). The issue ([#362][issue362], jwaltz, 2026-09-25) meets it after a back/forward-cache navigation. Same root as #381 — a departed worker's lock released before its handles — but in a cleanup, so the fix tolerates instead of retrying. This library masks it: `createVfsInstance` retries the failed `create()`, at a cost of ~85 ms on the first open after a cached page.

## How it was found

Reported upstream. We reproduced it with the real navigation twice: on 2026-09-30 under Playwright with the full Chromium build (LEAK-LIB: wa-sqlite alone failed the first open 18 of 18, this library's `dist/` succeeded 18 of 18 in 135-144 ms), and on 2026-10-16 under WebdriverIO on Chrome for Testing 153 against upstream `6238f532` (`master` 18 of 18 failed, tolerating the error 0 of 18). Firefox does not reach the condition by navigation: a page holding the database open leaves with `persisted === false`. Full numbers: `mem:measurements/opfs-handles`. On 2026-10-16 we offered the PR on the issue (issuecomment-6215879523); rhashimoto accepted on 2026-10-17.

## The change

In the sweep, `removeEntry()`'s `.catch` also tolerates `NoModificationAllowedError`, and the directory stays. A later instance deletes it once its files are closed, as the sweep already does for a directory another instance deleted first. One condition; nothing changes on the normal path.

## The test

In `test/vfs_handover.js`, beside #347's case: `createHolder()` (`test/vfs_handle_recovery.js`, which now takes an optional subdirectory) holds an access handle on `0.tmp` inside an `.ahp-held-*` directory whose lock nobody holds — the state the evicted page leaves. A new instance must start (`startInstance()`, which rejects on a failed start where `TestContext.create()` hangs); then, once the handle is closed, the next instance must have deleted the directory. No navigation is needed, and the condition does arise on Firefox this way.

On `master` (`6b59b231`): fails on default, asyncify and jspi with `NoModificationAllowedError`, Chrome 153 (upstream's runner and config) and Firefox 155 (the fork's WebDriver harness of `probe/stock-browsers`, with the PR's test files and either VFS copied over it, not committed). With the change: `OPFSCoopSyncVFS.test.js` 170/170 on Chrome and 126/126 on Firefox; the whole suite on Chrome 15/15 files, 6 449 assertions. Safari not run.

## Posted upstream

PR [#386][pr386], opened 2026-10-23 from `lalexdotcom:opfscoopsync-sweep-held-directory`, on `master` at `6b59b231`, one commit (`a21e9d45`). The body opens by saying it is the PR offered in #362 (user), says it reproduces in Chrome and Firefox, carries no measurement and does not mention this library. It states the conflict with #381 and what we do in each merge order (user): the source merges cleanly, `test/vfs_handover.js` conflicts — both PRs append a case to the same `describe`, and #381 makes `startInstance()` resolve to `{ worker, port }` — so whichever merges second is rebased, both cases kept, this one's two `startInstance()` calls using `.worker`. No conflict with #382, #384 or #385.

## What stays ours

- **Not carried yet.** The fix is not in [`patches/`](../../patches); carrying it beside #381's hunks regenerates the patch (`mem:stack-and-build/wa-sqlite`). Until then, and after, `createVfsInstance`'s retry keeps masking the failure; it stays for `AccessHandlePoolVFS` regardless.
- **The library-side test of the real navigation** (user, 2026-10-16) is still owed: a top-level page, since a Vitest test runs in an iframe that is never cached (`mem:follow-ups`).
