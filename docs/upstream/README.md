# Upstream

Work sent to [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), and the
measurements behind it. browser-sqlite ships the same fixes ahead of them being
merged, through [`patches/`](../../patches).

| | |
| --- | --- |
| [wa-sqlite #341 — `OPFSCoopSyncVFS` hangs on a fresh file](2026-09-16-wa-sqlite-341-coopsync-hang.md) | Reproduced against upstream, fixed by our PR #347, merged 2026-09-26. Includes why the reproduction published in the issue could not work. |
| [wa-sqlite #348 — TEXT values lose everything after an embedded NUL](2026-09-16-wa-sqlite-348-embedded-nul-text.md) | Picks up a stalled PR, answers its review, merged 2026-09-26. Why `TextDecoder` needs `ignoreBOM` here. |
| [wa-sqlite #350 — a failed access handle acquisition leaks the others](2026-09-18-wa-sqlite-350-coopsync-access-handle-leak.md) | Found as the reason a fix of ours could not work. Why one failed open made `OPFSCoopSyncVFS` block itself for good. |
| [wa-sqlite #351 — `IDBBatchAtomicVFS` writes through a block it assumed was there](2026-09-18-wa-sqlite-351-idb-sparse-write.md) | Write shapes the block store never handled, one of them corrupting the file silently. Why the abandonment was not the cause. Revised: a persistent journal reaches them too, and our first fix left overlapping blocks. Merged 2026-10-01. |
| [wa-sqlite #352 — `IDBMirrorVFS` writes zeroes where SQLite stamps its journal header](2026-09-18-wa-sqlite-352-idb-mirror-proxy-write.md) | A rollback that undoes nothing, because the journal header never reached the store. Six hypotheses refuted, and a test that passes against the bug. Merged 2026-09-30. |
| [wa-sqlite #353 — `IDBMirrorVFS` keeps every block a shrinking database leaves behind](2026-09-18-wa-sqlite-353-idb-mirror-block-leak.md) | Found by questioning a sentence in #352's report. Why the scenario a bug is found through is not always the one that demonstrates it. Merged 2026-09-30. |
| [wa-sqlite #357 — an open that fails asynchronously loses its cause](2026-09-21-wa-sqlite-357-coopsync-open-last-error.md) | The defect that made #350 findable only by hand. Why SQLite's own message cannot carry it, and why the test harness could not see it. |
| [wa-sqlite #361 — a checkpoint that costs one call per page](2026-09-23-wa-sqlite-361-writeahead-checkpoint-coalesce.md) | Why `OPFSWriteAheadVFS` gave back only a third of an abandoned write. A threshold, `readwrite-unsafe` and a Chromium-only cause, all refuted before the real one. Then the review's plan, and why the bounded buffer did not bound the process. |
| [wa-sqlite #363 — a lock released before the truncation it covers](2026-09-25-wa-sqlite-363-anycontext-unlock-truncate.md) | Found by a probe asking something else. Why a `VACUUM` on `OPFSAnyContextVFS` failed the next read on Firefox, traced one VFS call at a time. Questioned: the truncation is SQLite's design, and `synchronous=OFF` hides whole commits. Merged 2026-10-03. |
| [wa-sqlite #365 — a read that starts before the news of a commit](2026-09-27-wa-sqlite-365-writeahead-read-freshness.md) | Merged 2026-09-29 as an opt-in, `PRAGMA wal_read_latest`. Why `OPFSWriteAheadVFS` could read one transaction behind: a broadcast and a query on two unordered channels, traced. What the barrier was really hiding, and why the first test could not fail. Why the maintainer kept eventual consistency, and what the worst case costs. |
| [wa-sqlite #366 — the build `OPFSWriteAheadVFS` works best with, never tested](2026-09-29-wa-sqlite-366-writeahead-default-build.md) | Found answering the maintainer's question on #365. Two test lists moved, and a first run on that build: all green. Merged 2026-09-29. |
| [wa-sqlite #367 — a write-ahead file left open by a failed open](2026-09-29-wa-sqlite-367-writeahead-open-leak.md) | #350's leak in `OPFSWriteAheadVFS`, found by the maintainer's question. Why it costs a handle on Chromium and the whole database on Firefox, measured per reopen. Merged 2026-10-02. |
| [wa-sqlite #368 — a pool that one failed creation blocks for good](2026-09-29-wa-sqlite-368-ahp-acquire-leak.md) | #350's leak in `AccessHandlePoolVFS`, on both engines. Why a pool file held for a moment was enough, and why the test cannot use the harness. Merged 2026-10-02. |
| [wa-sqlite #369 — an open lock kept by an open that failed](2026-09-29-wa-sqlite-369-adaptive-open-lock.md) | The same family in `OPFSAdaptiveVFS`, on Firefox only. Why Chromium never shows it, and how the test makes it take Firefox's path. Merged 2026-10-03. |
| [wa-sqlite #370 — a journal deletion the lock did not wait for](2026-10-01-wa-sqlite-370-idb-journal-delete.md) | Why a second client on `IDBBatchAtomicVFS` counted 0 tables: it rolled back a committed transaction from a journal whose deletion died with its worker. Why SQLite asks for `syncDir` there, two fixes and the one sent, and the other VFS checked. Merged 2026-10-03. |
| [wa-sqlite #371 — a commit whose IndexedDB transaction aborts](2026-10-03-wa-sqlite-371-idb-mirror-commit-abort.md) | Why `IDBMirrorVFS` stored failed rows or corrupted the database after a quota abort. Why failing every call afterwards corrupted it again on reopen, five fixes measured side by side, and the reload design sent, each part justified by a test. |

[`repro/`](repro) holds the scripts, self-contained: each runs from a plain
wa-sqlite checkout with nothing but Playwright installed.
