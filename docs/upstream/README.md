# Upstream

Work sent to [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), and the
measurements behind it. browser-sqlite ships the same fixes ahead of them being
merged, through [`patches/`](../../patches).

| | |
| --- | --- |
| [wa-sqlite #341 — `OPFSCoopSyncVFS` hangs on a fresh file](2026-09-16-wa-sqlite-341-coopsync-hang.md) | Reproduced against upstream, fixed by our PR #347, merged 2026-09-26. Includes why the reproduction published in the issue could not work. |
| [wa-sqlite #348 — TEXT values lose everything after an embedded NUL](2026-09-16-wa-sqlite-348-embedded-nul-text.md) | Picks up a stalled PR, answers its review, merged 2026-09-26. Why `TextDecoder` needs `ignoreBOM` here. |
| [wa-sqlite #350 — a failed access handle acquisition leaks the others](2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md) | Found as the reason a fix of ours could not work. Why one failed open made `OPFSCoopSyncVFS` block itself for good. |
| [wa-sqlite #351 — `IDBBatchAtomicVFS` writes through a block it assumed was there](2026-09-18-wa-sqlite-351-idb-sparse-write.md) | Two write shapes the block store never handled, one of them corrupting the file silently. Why the abandonment was not the cause. |
| [wa-sqlite #352 — `IDBMirrorVFS` writes zeroes where SQLite stamps its journal header](2026-09-18-wa-sqlite-352-idb-mirror-proxy-write.md) | A rollback that undoes nothing, because the journal header never reached the store. Six hypotheses refuted, and a test that passes against the bug. |
| [wa-sqlite #353 — `IDBMirrorVFS` keeps every block a shrinking database leaves behind](2026-09-18-wa-sqlite-353-idb-mirror-block-leak.md) | Found by questioning a sentence in #352's report. Why the scenario a bug is found through is not always the one that demonstrates it. |
| [wa-sqlite #357 — an open that fails asynchronously loses its cause](2026-09-21-wa-sqlite-357-coopsync-open-last-error.md) | The defect that made #350 findable only by hand. Why SQLite's own message cannot carry it, and why the test harness could not see it. |
| [wa-sqlite #361 — a checkpoint that costs one call per page](2026-09-23-wa-sqlite-361-writeahead-checkpoint-coalesce.md) | Why `OPFSWriteAheadVFS` gave back only a third of an abandoned write. A threshold, `readwrite-unsafe` and a Chromium-only cause, all refuted before the real one. Then the review's plan, and why the bounded buffer did not bound the process. |
| [wa-sqlite #363 — a lock released before the truncation it covers](2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md) | Found by a probe asking something else. Why a `VACUUM` on `OPFSAnyContextVFS` failed the next read on Firefox, traced one VFS call at a time. |

[`repro/`](repro) holds the scripts, self-contained: each runs from a plain
wa-sqlite checkout with nothing but Playwright installed.
