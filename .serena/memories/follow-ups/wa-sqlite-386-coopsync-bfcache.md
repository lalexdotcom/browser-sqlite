# Follow-up — wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR #386 open

**Status: OPEN** — PR open; a browser test of the real navigation is to do.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

**PR #386 opened 2026-10-23** (rhashimoto accepted the offer on 2026-10-17, issuecomment-6236936019), branch `opfscoopsync-sweep-held-directory` of the fork, on `master` `8a8bc2ee` since its rebase; report `docs/upstream/2026-10-23-wa-sqlite-386-coopsync-sweep-held-directory.md`. Carried since the repin to `6b59b231` (2026-10-23); rebased onto `8a8bc2ee` after #381 merged (`c4f832ea`, same day).

**To do (user, 2026-10-16): a browser test of the real navigation.** None exists (`vfs-create-retry.test.ts` holds a pool file, no navigation); Safari is unmeasured. Chrome for Testing under WebDriver caches a page not served `no-store`; a Vitest test runs in an iframe, never cached, so it needs a top-level page — to design.
