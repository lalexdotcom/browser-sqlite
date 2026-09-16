# Upstream

Work sent to [wa-sqlite](https://github.com/rhashimoto/wa-sqlite), and the
measurements behind it. browser-sqlite ships the same fixes ahead of them being
merged, through [`patches/`](../../patches).

| | |
| --- | --- |
| [wa-sqlite #341 — `OPFSCoopSyncVFS` hangs on a fresh file](2026-09-16-wa-sqlite-341-coopsync-hang.md) | Reproduced against upstream, fixed by our PR #347. Includes why the reproduction published in the issue could not work. |

[`repro/`](repro) holds the scripts, self-contained: each runs from a plain
wa-sqlite checkout with nothing but Playwright installed.
