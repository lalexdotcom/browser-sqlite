# wa-sqlite #351 — `IDBBatchAtomicVFS` writes through a block it assumed was there

*2026-09-18, revised 2026-09-30 — found by triaging eight matrix failures, measured on Chromium and Firefox*

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

`flags = 0x806` is `MAIN_JOURNAL`: SQLite rewrites 12 bytes at the start of a 512-byte journal header, the record counter. That one fits inside its block, so the branch is right to exist — but it establishes that block sizes and write sizes vary independently. Which raises the case the suite never reached: a write *longer* than the block covering its start. A VFS-level test constructs it — 512 bytes at offset 0, then a full page at offset 0. SQLite itself never writes that sequence; it reaches the same shape another way, with a persistent journal (see the revision below).

**Both cases fail on master, and the first fails silently.** Its write raises nothing; every later read of the file returns `SQLITE_IOERR_READ` and zeroes.

## The fix, and why it is shaped like `jRead`

`jRead` already walks the blocks it finds and checks that each reaches the offset asked for (`block.data.byteLength - block.offset <= fileOffset` → short read). `jWrite` did neither. It now performs the same walk with the same test: it writes into each block covering part of the range, and stores what no block covers as a new block — which is what the extension branch directly above it already does.

The asymmetry was the defect. The reader knew the blocks could be of any size, arranged with gaps; the writer assumed one block, starting exactly at the offset, large enough for everything.

## Evidence

- `test/vfs_sparse_write.js` in wa-sqlite's own suite, both cases through `jWrite`/`jRead` directly, so neither depends on how SQLite orders its writes. Red on `master`, green with the fix.
- wa-sqlite's full suite: **2910 passing, 0 failing**, 13 files. That count left out every JSPI test: the branch predated upstream's fix to its JSPI detection, so they were skipped without a word (see the revision below).
- Here: `IDBBatchAtomicVFS` cells went from 4 failures to **662/662** on Chromium and **670/670** on Firefox, conformance 71 and 67, `pnpm test` 1171/672/14 — all after a clean `pnpm install`, so the patch reproduces the state.

**One reservation, which turned out to be a defect.** Storing as a new block what no block covers can shadow a block further along the range. This report first argued that the extension branch had the same property, so the fix only followed the VFS's convention. That was wrong: the extension branch writes past the end of the file, where no block can start, so it cannot overlap anything. The revision below is what came of it.

## Posted upstream

PR [#351][pr351] on 2026-09-18, two commits: the fix, then the tests. No external reproduction this time — the falsifier lives in wa-sqlite's own suite and calls the VFS directly, which is stronger than a script and runs on the maintainer's machine.

## Revision, 2026-09-30 — a wrong sentence, and the flaw it led to

**The maintainer's question.** The PR description said that SQLite "writes a 512-byte journal header, then a full page at the same offset". rhashimoto asked how that could be: it would make the journal invalid. He was right. The sequence came from our own VFS-level test, and the description had presented it as SQLite's behaviour.

**The case is real, with `journal_mode=PERSIST`.** A persistent journal is kept between transactions, and a new transaction's records do not line up with the blocks an earlier one left. With the default cache size, an `INSERT` of 3000 rows followed by three `UPDATE`s makes 895 journal writes longer than the block at their start. On upstream master that sequence logs `RangeError: offset is out of bounds` on Chromium and never settles on Chromium or Firefox. `DELETE` and `TRUNCATE` modes produce no such write: the journal starts empty each time.

**Checking it found a flaw in the first fix.** When SQLite starts a new journal segment it puts the header on the next 512-byte boundary and leaves the bytes before it unwritten. Traced on one journal:

```
transaction 1   put   8716+4      -> [8716, 8720)     end of a record
                put   9216+512    -> [9216, 9728)     next segment's header; [8720, 9216) never written
transaction 2   walk  8720+4      -> no block reaches 8720 -> new [8720, 8724)
                walk  8724+4096   -> no block reaches 8724 -> new [8724, 12820)   contains [9216, 9728)
```

The first fix stored everything no block covered as one new block, so it ran over the old header. `jRead` picks the block that starts closest before the offset it reads: a read starting at 9216 returned the stale header, and one starting past 9728 a short read and zeroes. Every overlap found in IndexedDB had its outer block created by that path; `journal_size_limit` truncations created none.

**What SQLite saw of it.** In 850 randomised rounds and five fixed scenarios on Chromium and Firefox, no read returned a wrong byte of the transaction in flight, and every `ROLLBACK` restored the snapshot taken before it. SQLite reads its records back at the offsets where it wrote them, and `jRead` changes block only when the current one is exhausted. The wrong bytes all belonged to earlier transactions, in two places SQLite expects leftovers: the 8-byte probe `syncJournal` makes where the next header will go, and a rollback whose last segment has `nRec` at 0, which counts records from the file size and walks stale ones until a read comes back short. The block store still returned something other than what was written, and a header's fields are read at offsets past where the header was written, so a layout that turns this into a wrong `nRec` or nonce was not ruled out. A randomised search did not find one.

**The second fix.** `jWrite` sends each byte to the block `jRead` will read it from: it writes into a block only up to where the next block starts, and a new block stops there too. One `getAllKeys` per overwrite gives the block starts inside the range. A first version of it threw `DataError` on a one-byte write, which SQLite does to invalidate a stale header; the SQL-level probe caught it, upstream's suite did not, and the PR now has a test for it.

**Evidence, on upstream master with the PR merged in.**

- `test/vfs_sparse_write.js`, four cases: the gap, the short block, a gap write over a block starting inside it (red on the first fix), a one-byte overwrite. `IDBBatchAtomicVFS` tests 128 passing on asyncify and JSPI; full suite 6067 passing on Chromium.
- Five scenarios (`PERSIST` with default and small cache, with `journal_size_limit`, `DELETE` as control) on both engines: no overlapping block, every journal byte reads back as written, 8 rollbacks of 8 correct in each.
- 725 randomised rounds: the same, with no wrong byte from any read that succeeded.
- Cost, median of three alternated runs of a workload that overwrites the journal about 46,000 times: +8% on Chromium (68.9 s to 74.2 s), +14% on Firefox (74.7 s to 85.3 s). In `DELETE` mode on Chromium, none.

**What is left as it was.** A read that crosses a range never written returns `SQLITE_IOERR_SHORT_READ` and zeroes the rest of the buffer, even when blocks exist further on. That is `jRead` on master, and upstream's #262 would remove those ranges at the source.

**Posted** on 2026-09-30: upstream master merged into the branch (it needed the JSPI detection fix), then the fix and the tests. The patch here carries the new head since the same day.

## Second review, 2026-09-30 — comments and a key range

rhashimoto reviewed the revised head the same evening and asked for retouches, none of them on the fix itself. He wrote out the comments he wanted: why blocks in IndexedDB must never overlap and how a write into a gap is bounded, and what limits each iteration of the loop. Both are in the code as he wrote them. The rule they show is not brevity — on #353 he had cut a comment to one sentence — but a comment that says how the code is rather than how it changed.

Another was the key range of the `getAllKeys` query: `-(iOffset + data.byteLength)` with an open lower bound instead of `- 1` and a closed one. It also removed the special case for a one-byte write, which skipped the query because equal bounds with an open end make `IDBKeyRange.bound()` throw; with both ends open the bounds always differ and the range is simply empty. A red arm checked that: the guard removed with the closed bound kept fails the single-byte test on asyncify and JSPI, with the open bound it passes. The last was an idea — one `getAll()` instead of a `get()` per piece — that he did not require; it cannot be a single call, since the block covering the start of the write may begin before it, so it went in as a TODO.

**Posted** on 2026-10-01 (`3e581623`): `IDBBatchAtomicVFS` tests 128 passing, full suite 6067 passing, upstream CI green. The patch here carries that head since the same day.

## Merged

**Merged on 2026-10-01** by rhashimoto, as `7a4b4241` on `master`; its `IDBBatchAtomicVFS.js` is byte for byte the head the patch carried. The pin moved to it the same day and the hunk left [`patches/`](../../patches). The TODO for a single `getAll()` stays upstream's.
