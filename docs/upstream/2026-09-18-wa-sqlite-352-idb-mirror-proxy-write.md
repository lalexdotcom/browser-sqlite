# wa-sqlite #352 — `IDBMirrorVFS` writes zeroes where SQLite stamps its journal header

*2026-09-18 — six hypotheses and three candidate fixes refuted before the cause showed itself*

**Why this is here.** [browser-sqlite](../../README.md) carries a patch to wa-sqlite ([`patches/wa-sqlite@1.1.2.patch`](../../patches)); this is its fifth hunk and its third file, upstream as [rhashimoto/wa-sqlite#352][pr352]. Of the three defects found in one day it is the worst: it corrupts a database on an ordinary rollback, with nothing raised at the time, and it needs no interruption, no concurrency and no savepoint to happen.

[pr352]: https://github.com/rhashimoto/wa-sqlite/pull/352

## The cause, in one line

`jWrite` copies into its buffer with `block.set(pData, iOffset)` for every file that is not the main database. **`pData` is a `Uint8ArrayProxy`, not a `Uint8Array`** — the class `FacadeVFS` uses to reacquire WebAssembly memory after a resize. It carries the methods but has no indexed access, so `TypedArray.prototype.set` treats it as an array-like, reads `undefined` at every index, and stores zeroes.

`FacadeVFS.js` says it plainly on the class itself — *"it is not a real Uint8Array […] Use subarray()"* — and `MemoryVFS` already complies. `IDBMirrorVFS` was the only VFS that did not.

**Why it stayed hidden.** A write that does not fit the current buffer takes the growth path, where the payload is copied by `newBlock.set(block)` between two real arrays; only a write that fits the existing buffer reaches the faulty line. SQLite's rollback journal is exactly that shape: the header is reserved first, the pages are journalled — growing the buffer — and only then does SQLite come back and stamp 12 bytes at offset 0.

```
write  off=0 len=12  src=d9d505f920a163d700000002
stored off=0         = 00000000
```

On rollback SQLite reads that header back, finds a journal that looks empty, concludes there is nothing to undo, and deletes it. The pages it had already written stay in the database, whose header no longer describes the file: `database disk image is malformed`.

## How it was found, because the route matters

The pile was 46 cell failures over twelve subjects, every one of them an abandoned write inside a transaction — which is what made the abandonment look causal. It is not. **Replaying the scenario without any transaction or savepoint of ours corrupts the database just the same**, and that measurement is what moved the subject upstream.

Six hypotheses were refuted by measurement before the cause appeared: misalignment in `jWrite`'s hole filling; a short read inside the file; an inconsistency between `blockSize * blocks.size` and the blocks' real reach; a change of `blockSize` mid-flight; an orphan block left by the truncation; and `SQLITE_IOCAP_BATCH_ATOMIC`, whose removal made things worse. Three candidate fixes were refuted the same way, including publishing at `COMMIT_PHASETWO` rather than at `SYNC`.

What finally worked was to stop guessing and trace. The worker's console does not reach the report, so the VFS posted its events on a `BroadcastChannel` that a throwaway test listened to and carried into its assertion. The trace showed SQLite journalling, stamping the header, then reading it back as zeroes — and from there the cause was two files away.

**Two traps on the way, both worth keeping.** `isolated` showed 0 failures on this VFS throughout: that configuration reads only `tests/browser/isolated/**`, a separate three-file suite, so it never ran these tests at all. And a test calling `jWrite` directly **passes against the bug** — Comlink clones its arguments, so the VFS receives a real `Uint8Array` and the proxy never appears. The defect only exists on the path where SQLite calls the VFS from WebAssembly.

## What is fixed, and what is not

Fixed: `block.set(pData.subarray(), iOffset)`.

**Not fixed, and still upstream's — two of them, and they do have a symptom.** `#acceptTx` truncates from `tx.fileSize + blockSize`, while the first block past the end of the file starts at `tx.fileSize` — one block too far, so one block survives every shrink; its loop also stops at the first absent block, so scattered blocks past the end survive too. And `#commitTx` writes the transaction's blocks to IndexedDB but deletes none, so everything a spill deposited past the end of the file stays there.

Measured after this fix: a database of **2 pages leaves 93 blocks in IndexedDB** once a spilled transaction is rolled back. It is a storage leak, not corruption — reopening gives `integrity_check` ok, the right rows and 2 pages — but a database that repeatedly rolls back large transactions fills its quota with dead blocks.

**It is NOT introduced by this fix**, and the measurement says so in both directions: 93 blocks with the fix, 93 without. Before the fix the leak was simply unreachable, hidden behind a database too corrupt to query. Anyone applying this patch will see that count and should not read it as a regression.

Not patched here because the purge is not ours to design: this VFS is multi-connection, and `#getOldestTxInUse` inspects the Web Locks other connections hold to decide how far it may prune — it already governs the `tx` store. Deleting blocks has to pass the same barrier, or it pulls data out from under a connection still reading an older view.

## Evidence

- `test/vfs_rollback.js` in wa-sqlite's own suite: a transaction large enough that SQLite must write pages before the commit, then rolled back, asserted through `PRAGMA integrity_check` and the table contents. Red on `master` with `database disk image is malformed`; green with the fix. Full suite 13 files, 0 failures.
- Here, `transaction.test.ts` gained the same case. It declares no `needs`, so it follows the target and runs on **every pair**: 286 passing on chromium and 286 on firefox — the file's 13 tests across all 22 `(vfs, build)` pairs, memory VFS and both async builds included.
- The `IDBMirrorVFS` cells went from 46 failures to none.

## Posted upstream

PR [#352][pr352] on 2026-09-18, two commits: the fix, then the test. The PR body states the widest true form of the defect — any transaction big enough to spill the page cache and then rolled back — rather than the abandoned write that led to it.
