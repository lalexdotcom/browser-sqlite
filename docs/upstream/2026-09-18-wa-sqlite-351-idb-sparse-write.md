# wa-sqlite #351 — `IDBBatchAtomicVFS` writes through a block it assumed was there

*2026-09-18 — found by triaging eight matrix failures, measured on Chromium and Firefox*

**Why this is here.** [browser-sqlite](../../README.md) carries a patch to wa-sqlite ([`patches/wa-sqlite@1.1.2.patch`](../../patches)); this is its fourth hunk and the first outside `OPFSCoopSyncVFS.js`, upstream as [rhashimoto/wa-sqlite#351][pr351]. The defect corrupts a file silently on one of its two paths, which is why it is worth this much writing.

[pr351]: https://github.com/rhashimoto/wa-sqlite/pull/351

## The pile that led here

`IDBBatchAtomicVFS` carried 8 of the matrix's cell failures: two tests — `tx-abort.test.ts :: undoes a caught write issued through tx.first()` and `tx-savepoint.test.ts :: undoes a caught write issued through tx.chunk()` — on both engines and both builds. Both cut a statement mid-flight with a signal.

**Two symptoms, and they looked unrelated.** On `jspi` the call failed with `offset is out of bounds` (Chromium) or `source array is too long` (Firefox); on `async` the test simply hung for its whole 30 s and the cleanup hook timed out after another 10. They are the same defect: the rejection happens inside a queued IndexedDB operation, and Asyncify swallows it where JSPI lets it through.

**`isolated` counted for nothing, and nearly misled the triage.** Its cells showed 0 failures — but that configuration runs 7 tests out of 334, and neither subject is among them. A green cell that does not run the test says nothing.

## What was measured

Instrumenting the write path gave the whole story in one line:

```
WRITE path=/z5ahixcvgeh flags=1054 iOffset=1843200 blockOffset=-1839104
      at=4096 room=0 data=4096 blockData=4096 fileSize=9469952
```

The write targets 1843200; no block starts there; the range yields the block at 1839104 — the *previous* one — and `iOffset + block.offset` lands exactly at the end of a 4096-byte block. `flags = 0x41E` is `TRANSIENT_DB`: the file SQLite opens to materialise a result, not the database and not the journal.

**The block was never written, not lost.** A second probe recorded every offset the instance had queued:

```
HOLE at 1843200: queued-before=0 totalQueued=2305
  neighbours=1835008,1839104,1847296,1851392
```

One page missing from an otherwise contiguous run of 2305. Nothing was aborted, no IndexedDB transaction was rolled back — SQLite simply wrote the following pages first. So **the abandonment is not the cause**: it changes the order in which the transient file is written, and that order is what the VFS could not handle. Any plan producing the same order reaches it without a signal in sight.

## The second case, found by not stopping at the first

The fix for the above could have been a special case. Pushing the verification further — a probe that shouted on *any* overwrite that was not block-for-block — showed that unaligned overwrites are ordinary:

```
UNALIGNED at=0 data=12 blockData=512 iOffset=0 blockOffset=0 flags=2054
```

`flags = 0x806` is `MAIN_JOURNAL`: SQLite rewrites 12 bytes at the start of a 512-byte journal header, the record counter. That one fits inside its block, so the branch is right to exist — but it establishes that block sizes and write sizes vary independently. Which raises the case the suite never reached: a write *longer* than the block covering its start. A VFS-level test produced it at once — 512 bytes at offset 0, then a full page at offset 0.

**Both cases fail on master, and the first fails silently.** Its write raises nothing; every later read of the file returns `SQLITE_IOERR_READ` and zeroes.

## The fix, and why it is shaped like `jRead`

`jRead` already walks the blocks it finds and checks that each reaches the offset asked for (`block.data.byteLength - block.offset <= fileOffset` → short read). `jWrite` did neither. It now performs the same walk with the same test: it writes into each block covering part of the range, and stores what no block covers as a new block — which is what the extension branch directly above it already does.

The asymmetry was the defect. The reader knew the blocks could be of any size, arranged with gaps; the writer assumed one block, starting exactly at the offset, large enough for everything.

## Evidence

- `test/vfs_sparse_write.js` in wa-sqlite's own suite, both cases through `jWrite`/`jRead` directly, so neither depends on how SQLite orders its writes. Red on `master`, green with the fix.
- wa-sqlite's full suite: **2910 passing, 0 failing**, 13 files, all VFS and builds.
- Here: `IDBBatchAtomicVFS` cells went from 4 failures to **662/662** on Chromium and **670/670** on Firefox, conformance 71 and 67, `pnpm test` 1171/672/14 — all after a clean `pnpm install`, so the patch reproduces the state.

**One reservation, and no test will lift it.** Storing as a new block what no block covers can in principle shadow a block further along the range. The extension branch above has had that same property all along, so the fix aligns with the VFS's existing convention rather than introducing a risk — but it is an alignment, not a guarantee.

## Posted upstream

PR [#351][pr351] on 2026-09-18, two commits: the fix, then the tests. No external reproduction this time — the falsifier lives in wa-sqlite's own suite and calls the VFS directly, which is stronger than a script and runs on the maintainer's machine.
