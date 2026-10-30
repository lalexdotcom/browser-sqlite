# Follow-up — `OPFSAdaptiveVFS` keeps its journal's access handle between transactions (wa-sqlite PR #389, 2026-10-30)

**Status: OPEN** — PR open, waiting for review.

Part of `mem:follow-ups`.

Without `readwrite-unsafe` (Firefox, Safari), `OPFSAdaptiveVFS` created, opened, closed and removed its `-journal` at every write transaction; [#389](https://github.com/rhashimoto/wa-sqlite/pull/389) keeps the journal's handle with the database's and truncates it, as `OPFSCoopSyncVFS` does. Found by `mem:follow-ups/firefox-opfs-fsync`; report, measurements and the test's falsification in `docs/upstream/2026-10-30-wa-sqlite-389-adaptive-keep-journal.md`. Fork branch `lalexdotcom:opfsadaptive-keep-journal` (`2352be7c`, worktree `.work/wa-sqlite-adaptive-journal`); upstream CI green. Carried in `patches/` since 2026-10-30 (`mem:stack-and-build/wa-sqlite`), with a CHANGELOG entry under *Changed*.

**When it merges:** repin, drop its hunk from the patch, and replace the CHANGELOG entry by the bump of wa-sqlite (`mem:conventions/upstream`). **On review:** answer per `mem:conventions/upstream` — argued for the engines without `readwrite-unsafe`, gains as a range, readability first.
