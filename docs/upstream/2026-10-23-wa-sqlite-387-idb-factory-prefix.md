# wa-sqlite #387 — `getIDBFactory` and `prefix` for the IndexedDB VFS

*2026-10-23 — measured on Chrome 153 and Firefox 155, in the container*

[pr387]: https://github.com/rhashimoto/wa-sqlite/pull/387
[pr380]: https://github.com/rhashimoto/wa-sqlite/pull/380

**Why this is here.** [#380][pr380] (darshanp40, merged 2026-10-23) gave `AccessHandlePoolVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` a `getRoot` option and a `prefix` for the Web Lock and BroadcastChannel names derived from file names. On 2026-10-19 we commented there that `getRoot` lets an app choose which databases get persistence: on Chromium each Storage Bucket has its own persistence and durability, so an app can keep the databases it cannot lose in a bucket opened with `persisted: true` and leave rebuildable ones where the browser may evict them. We offered the same on the IndexedDB side as a follow-up PR; rhashimoto answered "Sure!" on 2026-10-23. That persistence-per-bucket use is the user's reason for the PR.

## Shape, decided with the user

- **#380's review is the specification.** rhashimoto asked there for `prefix` rather than `lockPrefix` (it names channels too), for the options read straight from `this.options` with the defaults in that field, and for no prefix on random temporary names. The PR applies the same to `getIDBFactory` (default `() => indexedDB`, a factory or a promise of one) and `prefix`.
- **One PR for both VFS (user)**, against `mem:conventions/upstream`'s one-PR-per-VFS rule, because the change goes through a shared mixin; the body says so (user).
- **`prefix` lives in `WebLocksMixin`** beside `lockPolicy` and `lockTimeout`, since the mixin builds `IDBBatchAtomicVFS`'s lock names. It therefore applies to `OPFSAdaptiveVFS`, `OPFSAnyContextVFS` and `OPFSPermutedVFS` too; the body says so and leaves it to rhashimoto to restrict (user).

## The change

`WebLocksMixin`: lock names become `lock##${prefix}${baseName}##…`. `IDBBatchAtomicVFS`: an `options` field, `IDBContext.create(factory, name)`, `idbName` kept. `IDBMirrorVFS`: an `options` field (its `options` argument was ignored before), the factory used in `#initialize()`, the prefix in `mirror:${prefix}${path}`, `${prefix}${path}@@…` and `${prefix}${path}@@[txId]`, and in `#getOldestTxInUse()`'s comparison of the transaction locks it reads back. Typedefs `IDBBatchAtomicOptions` and `IDBMirrorOptions`.

**Found on the way:** `WebLocksMixin` builds its names from `getFilename()`, which for `IDBBatchAtomicVFS` is `IDB(<vfs name>):<path>`. Two such VFS with different names already had distinct locks; the collision the prefix prevents is the same VFS name in two factories. A first version of the lock test, using two VFS names in one factory, passed on `master` for that reason and was rewritten on bucket against default, like `vfs_root.js`.

## The tests

`test/vfs_idb_factory.js` and its worker (asyncify build), run for both VFS, with `test/customFactory.js` on the model of `customRoot.js`: the database is in the bucket and not the default factory; it keeps apart from a database of the same name in the default factory, data and messages; a write transaction in the bucket does not block a file of the same name in the default factory; a rejecting `getIDBFactory` fails the open with its error. `-customFactory` configurations in `test-worker.js` run `vfs_xAccess`/`xOpen`/`xClose`/`xRead`/`xWrite` through a bucket; reset deletes the bucket.

| arm | Chrome 153 | Firefox 155 (no Storage Buckets) |
|---|---|---|
| `master` `6b59b231` | the 4 tests fail on both VFS | the rejection test fails on both, the rest pending |
| the change | `IDBBatchAtomicVFS` 181/181, `IDBMirrorVFS` 269/269; whole suite 15/15 files, 6 529 | green |
| the change, `prefix` emptied in `customFactory.js` | lock test fails on both; the separation test fails on `IDBMirrorVFS` | — |
| the change, `#getOldestTxInUse()` without the prefix | **all green: the line is untested** | — |

Chrome ran upstream's runner and config; Firefox the fork's WebDriver harness of `probe/stock-browsers` with the branch's `src/`, `test/` and `dist/` copied over it, not committed. The untested line: with it wrong, a committer would compute the oldest view in use as its own and delete `tx` records a lagging connection with the same prefix still needs, visible only after a missed broadcast. Upstream has no test of that retention even without a prefix. A Mirror-only test reading the bucket's `tx` store while a connection holds an old view was offered to the user and not written; the PR names the line for review.

## Posted upstream

PR [#387][pr387], opened 2026-10-23 from `lalexdotcom:idb-factory-prefix`, on `master` at `6b59b231`, one commit (`7805bb2f`). The body opens by saying it is the follow-up offered in #380, explains the persistence use, says the PR spans several VFS because of the mixin and which other VFS the option reaches, and states the only conflict — an import beside #385's in `test/IDBMirrorVFS.test.js` — with what we do in each merge order. No conflict with #381, #382, #384, #386. It does not mention this library.

## What stays ours

- **Not carried.** Nothing in this library uses the options yet; whether it exposes Storage Buckets is not decided.
