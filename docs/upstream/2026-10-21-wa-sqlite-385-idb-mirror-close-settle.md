# wa-sqlite #385 — `IDBMirrorVFS.close()` returns before its transactions finish

*2026-10-21 — measured on Chrome 153 and Firefox 155 (container, Linux); the Safari side measured on Safari 26.6.2 (GitHub `macos-latest`) and 27.0.1 (the user's Mac)*

[pr385]: https://github.com/rhashimoto/wa-sqlite/pull/385
[pr384]: https://github.com/rhashimoto/wa-sqlite/pull/384
[webkit324094]: https://bugs.webkit.org/show_bug.cgi?id=324094

**Why this is here.** The `IDBMirrorVFS` side of [#384][pr384], for the same reason: on Safari, a worker ended before its last IndexedDB transaction fired `complete` can leave its connection open, so `indexedDB.deleteDatabase` and upgrades block ([WebKit 324094][webkit324094]; SAFARI-IDB-STRAND, `mem:measurements/test-browsers`). On this VFS the library's pool `close` once answered with a readwrite transaction still live (`query-timeout`, SAFARI-IDB-LIB): `IDBMirrorVFS` writes at open.

## How it was found

#384's body said `IDBMirrorVFS` was being looked into. In the code (upstream `6238f532`), `close()` returns `IDBDatabase.close()`. Five places start a transaction: `jOpen()` (readwrite: count, a `put` for a new file, then `#loadFile`), `jLock()` towards `RESERVED` (readonly), `#commitTx()` (readwrite), `#reloadFile()` (readonly) and `#deleteFile()` (readwrite). `jClose()` waits for the commits since #372 (`commitsInFlight`), and `#deleteFile()` waits for its own `complete`. The others are awaited on their requests only.

## Measured

IDB-CLOSE-384 in `mem:measurements/wa-sqlite-prs`, same probes and harness as #384. On `master`, a transaction is live when `await vfs.close()` resolves after an open alone (17/20 Chrome, 20/20 Firefox) or a read (16/20, 20/20), never after a write (`jClose` waited for the commit). No commit was lost (0/40 under `normal` and `full`), and `deleteDatabase` never saw `blocked`. With the change: 0/20 in every cell on both engines, still 0/40 lost.

**So Safari's bug is the only consequence found.** WebKit fixed it in 321564@main (Safari Technology Preview 254); 27.0.1 still has it, and earlier versions too, iOS 18.3.2 included. Once the Safari versions in use carry the fix, the change has no known effect. #384 is different: its lost commit is Chrome's and Firefox's, Safari or not.

## The change

A private `#transaction(storeNames, mode = 'readonly')` starts every transaction and adds a promise, settled on `complete` or `abort` and then removed, to a set. `close()` becomes `async`: it calls `IDBDatabase.close()` first (transactions already started still run to completion; a new one would throw `InvalidStateError`), then waits for the set. Cost: `close()` resolves after the last transaction finishes instead of before.

## The test

`test/vfs_close_settles.js`, run by `IDBMirrorVFS.test.js` for both builds, on the page: `IDBDatabase.prototype.transaction` is wrapped for the test (restored in `afterEach`) to count transactions until `complete` or `abort`; five rounds, each creating and writing a database, then reopening and reading it, with no live transaction allowed after either `vfs.close()`. Unlike #384's, it asserts the cause, not a consequence: Chrome and Firefox have none to show. On `master` it failed in 3 of 3 runs per engine, both builds (7-10 of 20 expectations); with the change 3 of 3 green per engine (246 passed). Upstream's whole suite on Chrome with upstream's config: 15/15 files, 6332 passed, 0 failed. Upstream CI (Chrome) can fail it.

## Posted upstream

PR [#385][pr385], opened 2026-10-21 from `lalexdotcom:idbmirror-close-settle` on `master` at `6238f532`: the test (`07a72609`), then the change (`086200d7`). The body, validated by the user, carries no measurement. At the user's request it says that the Safari bug is the only consequence found, that WebKit has fixed it but only in Technology Preview so far, and that the change has no known effect once the Safari versions in use carry the fix. It has a short "Relation to #384" (same change, different files, no conflict). It does not mention this library.

## What stays ours

- Carry #384 and #385 as a `pnpm patch`; the library then calls `await vfs.close()` on its pool's `close` path (it never closes its VFS there today) and keeps it in the delete worker, instead of the two waits before `closed` and `deleted`. Whether the forced-kill quiesce also closes the VFS, and `src/worker/idb-transactions.ts` goes, is open (`mem:follow-ups/safari-idb-stranded`).
