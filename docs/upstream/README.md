# Upstream

Work sent to [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), and the
measurements behind it. browser-sqlite ships the same fixes ahead of them being
merged, through [`patches/`](../../patches).

| | |
| --- | --- |
| [wa-sqlite #341 — `OPFSCoopSyncVFS` hangs on a fresh file](2026-09-16-wa-sqlite-341-coopsync-hang.md) | Reproduced against upstream, fixed by our PR #347. Includes why the reproduction published in the issue could not work. |
| [wa-sqlite #348 — TEXT values lose everything after an embedded NUL](2026-09-16-wa-sqlite-348-embedded-nul-text.md) | Picks up a stalled PR, answers its review. Why `TextDecoder` needs `ignoreBOM` here. |
| [wa-sqlite #350 — a failed access handle acquisition leaks the others](2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md) | Found as the reason a fix of ours could not work. Why one failed open made `OPFSCoopSyncVFS` block itself for good. |
| [wa-sqlite #351 — `IDBBatchAtomicVFS` writes through a block it assumed was there](2026-09-18-wa-sqlite-351-idb-sparse-write.md) | Two write shapes the block store never handled, one of them corrupting the file silently. Why the abandonment was not the cause. |
| [wa-sqlite #352 — `IDBMirrorVFS` writes zeroes where SQLite stamps its journal header](2026-09-18-wa-sqlite-352-idb-mirror-proxy-write.md) | A rollback that undoes nothing, because the journal header never reached the store. Six hypotheses refuted, and a test that passes against the bug. |
| [wa-sqlite #353 — `IDBMirrorVFS` keeps every block a shrinking database leaves behind](2026-09-18-wa-sqlite-353-idb-mirror-block-leak.md) | Found by questioning a sentence in #352's report. Why the scenario a bug is found through is not always the one that demonstrates it. |
| [wa-sqlite #357 — an open that fails asynchronously loses its cause](2026-09-21-wa-sqlite-357-coopsync-open-last-error.md) | The defect that made #350 findable only by hand. Why SQLite's own message cannot carry it, and why the test harness could not see it. |

[`repro/`](repro) holds the scripts, self-contained: each runs from a plain
wa-sqlite checkout with nothing but Playwright installed.
