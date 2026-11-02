# Follow-up — wa-sqlite #362: `OPFSCoopSyncVFS.create()` fails after a back/forward-cache navigation — PR #386 open

**Status: OPEN** — PR open; a browser test of the real navigation is to do.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

**PR #386 opened 2026-10-23** (rhashimoto accepted the offer on 2026-10-17, issuecomment-6236936019), branch `opfscoopsync-sweep-held-directory` of the fork, on `master` `8a8bc2ee` since its rebase; report `docs/upstream/2026-10-23-wa-sqlite-386-coopsync-sweep-held-directory.md`. Carried since the repin to `6b59b231` (2026-10-23); rebased onto `8a8bc2ee` after #381 merged (`c4f832ea`, same day).

**What the real navigation does per engine (2026-11-02, probe pages served from the container, `bf.html`/`lib.html` in the session scratchpad):** Chrome 156 on macOS reaches #362 — upstream `e4f54a05` fails every other page with `NoModificationAllowedError` on `removeEntry`, #386 opens all 10; every page cached. Playwright's WebKit (Linux) caches no page, so proves nothing. **Safari 27.2 never reaches #362**: the cached page's worker keeps `ahp:/<file>` and its `.ahp-*` lock, the sweep skips the locked directory, and the next page's `open_v2()` waits on the lock for good — a different defect, the library's side recorded in `mem:follow-ups/bfcache-auto-suspend` (DEFERRED) and fixed for now in docs and an open-error message (`fix/bfcache-held-database`). So the test of #386's real navigation is Chrome's; its design (a top-level page driven by WebDriver, a check that the page left was really cached) was started on 2026-11-02 and paused there.

**To do (user, 2026-10-16): a browser test of the real navigation.** None exists (`vfs-create-retry.test.ts` holds a pool file, no navigation); Safari is unmeasured. Chrome for Testing under WebDriver caches a page not served `no-store`; a Vitest test runs in an iframe, never cached, so it needs a top-level page — to design.
