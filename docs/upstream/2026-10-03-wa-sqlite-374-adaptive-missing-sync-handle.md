# wa-sqlite #374 — `OPFSAdaptiveVFS` cannot be imported where `FileSystemSyncAccessHandle` is missing

*2026-10-03 — measured on Chromium and Firefox (Playwright 1.62.1), in the container*

[pr374]: https://github.com/rhashimoto/wa-sqlite/pull/374

**Why this is here.** `OPFSAdaptiveVFS.js` reads `globalThis.FileSystemSyncAccessHandle.prototype` while the module is evaluated. This library bundles every VFS into one worker file, so wherever that interface is missing, the worker cannot load at all, `MemoryVFS` and the IndexedDB VFS included. That covers a page that is not a secure context, and browsers older than the interface (Chrome before 102, Chrome for Android before 109, Firefox before 111) — below the floors `VFS.md` gives for the memory and IndexedDB VFS. Carried in [`patches/`](../../patches) since 2026-10-03.

## How it was found

It sat in `mem:follow-ups` since 2026-09-14, seen when Playwright's Linux WebKit, which lacks the interface, failed every VFS. Measuring whether a consumer could meet it, on a page served over plain http from the container's own address (not a secure context), showed the library failing earlier, on its own `crypto.randomUUID()`. Once that was replaced, every client failed `WORKER_CRASHED` on this line, on both engines (INSECURE-CONTEXT, `mem:measurements`).

## The change

`globalThis.FileSystemSyncAccessHandle?.prototype.hasOwnProperty('mode')`: where the interface is missing, `hasUnsafeAccessHandle` is `undefined`, as falsy as before; where it exists, nothing changes. The VFS still cannot run without the interface; importing it no longer throws.

## The test

In `test/OPFSAdaptiveVFS.test.js`, build-independent: the test page is a main thread, where the interface does not exist in either engine (it is exposed to dedicated workers only), so the test asserts that, then imports the module and expects no error. On `master` it fails on Chromium and Firefox with the `TypeError`'s message; with the change the file's 72 tests pass 3 of 3 on both, and the whole suite passes on Chromium with the repository's own config (6158). A first form, `expectAsync(import(...)).toBeResolved()`, made the page hang on `master` instead of failing, so the test catches the import error itself.

## Posted upstream

PR [#374][pr374], opened 2026-10-03 from `lalexdotcom:fix/adaptive-missing-sync-handle`, on `master` at `7fcc30df`: the fix (`39e7e1ff`), then the test (`80934a52`). The body names the three cases (a main thread or Node, a page that is not a secure context, older browsers) and the worker that bundles several VFS, in words; it does not mention this library. It touches no file #371 or #372 changes. Upstream CI on the head commit is green: [run 37157798485](https://github.com/rhashimoto/wa-sqlite/actions/runs/37157798485), `build (20.x)`, the only check.

## What stays ours

- **The carry.** The patch holds this line, byte-identical to the PR, beside #371 and #372.
- **The library side** — `randomId()` instead of `crypto.randomUUID()`, and `web-locks` required by every VFS outside memory — is ours alone (`CHANGELOG.md`, Fixed).
