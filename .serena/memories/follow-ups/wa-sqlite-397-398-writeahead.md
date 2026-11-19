# Follow-up — wa-sqlite issues #397 and #398: two `OPFSWriteAheadVFS` defects reported upstream (seen 2026-11-19)

**Status: OPEN** — both are ISSUES, not pull requests (`mem:state` called them PRs until 2026-11-19); opened by cdargel, open, no fix proposed upstream as of 2026-11-19. Nothing done here yet. Decision owed before 1.0.0 (user): wait for upstream, propose a fix (as for #384-#389), or document the risk.

Part of `mem:follow-ups`.

- **#397 — "WriteAhead: a failed write in commit() leaves `#txInProgress` set".** A write that fails inside `commit()` (a quota failure at commit reaches it) leaves the VFS believing a transaction is still in progress. Effect on the library not measured.
- **#398 — "WriteAhead: a passive checkpoint after an interrupted non-passive checkpoint can write older pages over newer ones".** A data-integrity report on a VFS the library recommends; the more serious of the two.
- **Why it matters here:** `OPFSWriteAheadVFS` is one of the recommended VFS (`RECOMMENDED_VFS`), and `patches/` carried our checkpoint rework (#361, merged upstream) on that same code.
- **Next:** read both issues and the code they point at, decide whether the library can reach either path (a quota failure at commit; an interrupted non-passive checkpoint — the library's own checkpoints and `close({ immediate: true })`), then the user picks the course.
