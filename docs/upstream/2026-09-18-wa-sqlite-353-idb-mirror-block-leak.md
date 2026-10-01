# wa-sqlite #353 — `IDBMirrorVFS` keeps every block a shrinking database leaves behind

*2026-09-18 — found by questioning a sentence in the report of [#352](2026-09-18-wa-sqlite-352-idb-mirror-proxy-write.md)*

**Why this is here.** [browser-sqlite](../../README.md) carries a patch to wa-sqlite ([`patches/wa-sqlite@1.1.2.patch`](../../patches)); this is its seventh hunk, upstream as [rhashimoto/wa-sqlite#353][pr353]. It is the mildest of the four defects of the day — it costs storage quota, not data — and the only one found by re-examining a claim rather than by chasing a failure.

[pr353]: https://github.com/rhashimoto/wa-sqlite/pull/353

## How it was found

The report of #352 said the truncation defect it left behind was "a genuine defect with no known symptom". The user asked why a defect had been left at all — and the answer, once measured, was that the sentence was wrong. The symptom had not been looked for, because the corruption #352 fixes made the database unqueryable long before anyone could count anything.

**A first version of the test made a second mistake worth recording.** It reproduced the leak through a rolled back transaction, which is the path the investigation came from — and that path needs #352 to be applied, since without it the database does not survive to be measured. On `master` the test failed on `database disk image is malformed`, not on the count: red for the wrong reason, and still red after the fix. The user asked for a test that discriminates on `master`, so that this could be merged in either order. Shrinking the database with `DELETE` + `VACUUM` reaches the same truncation without rolling anything back, and shows the leak more plainly: **531 blocks kept for a 2-page database**, against 93 by the rollback route.

The route mattered more than the defect here: the scenario the bug was found through was not the scenario that demonstrates it.

## What happens

Two places keep the blocks.

`#acceptTx` truncates the in-memory view from `tx.fileSize + blockSize`, but the first block past the end of the file starts at `tx.fileSize` — one block too far, so one survives every shrink. Its loop also stops at the first absent block (`Map.delete` returns `false`), so blocks past the end that are not contiguous survive as well.

`#commitTx` writes the transaction's blocks to IndexedDB and deletes none, so everything a transaction wrote before shrinking stays in the store.

**The database stays correct.** Reopening reads the right rows, `integrity_check` passes, `page_count` is right. The leak does not accumulate either — a second rollback rewrites the same offsets — and it resolves if the database grows again. What is held is the high-water mark: a database that repeatedly grows and shrinks keeps the largest size it ever reached.

## Why deleting from the store is safe, and how that was established

Blocks are not versioned: the key is `[path, offset]`, so a block has exactly one value. Connections learn about changes through the `BroadcastChannel`, and the message carries the block data itself rather than a pointer into IndexedDB — so a live reader is not reading the store when another connection commits. IndexedDB is read on open and written on commit.

`#getOldestTxInUse` inspects the Web Locks other connections hold, and it guards the `tx` store, whose records are what lets a connection catch up. It is untouched.

That reasoning was checked against the suite rather than trusted: the `IDBMirrorVFS` cells stay green on both engines, `multi-client` and `cross-tab` included.

## Not introduced by #352

Measured in both directions before the fix: 93 blocks with #352 applied, 93 without. The leak predates it; #352 only makes it reachable, by leaving a database one can still query. Anyone applying these patches in order will see the count and should not read it as a regression — which is why it is written here and in the report of #352.

## Evidence

- `test/vfs_leak.js` in wa-sqlite's own suite: grow the database well past the page cache, empty it, `VACUUM`, and compare the blocks IndexedDB holds with `PRAGMA page_count`. Red on `master` — 531 against 2 — and green with the fix, with the full suite at 13 files, 0 failures.
- No test was added here: the case is upstream's to guard, and nothing in this library's behaviour changes.

## Posted upstream

PR [#353][pr353] on 2026-09-18, two commits: the fix, then the test. Explicitly independent of #352 — it applies to `master` as it stands, and its test fails there for the right reason, so the maintainer can take them in either order.

## Revised in review

rhashimoto reviewed it on 2026-09-29. The comments were cut to one sentence each, and the fix lost a computation he called unnecessary: both places rounded the file size up to a block boundary before comparing, and a database file is always a whole number of pages. The comparison is now with the file size itself — which selects the same blocks in any case, since a block's offset is a multiple of the block size. The guards on `blockSize` existed only to keep that division away from zero and went with it.

Pushed on 2026-09-30 with upstream `master` merged into the branch, so that its JSPI tests run there: the branch predated upstream's fix to its JSPI detection, and skipped them without saying so. `test/vfs_leak.js` fails on `master`'s file on both builds, 531 blocks against 2, and passes with the revised fix; the patch here carries that head.

## Merged

**Merged on 2026-09-30** by rhashimoto, as `54c04364` on `master`, right after [#352](2026-09-18-wa-sqlite-352-idb-mirror-proxy-write.md). Both left [`patches/`](../../patches) at the repin of 2026-10-01 to `7a4b4241`, their `IDBMirrorVFS.js` byte for byte the heads the patch carried; that file is no longer patched.
