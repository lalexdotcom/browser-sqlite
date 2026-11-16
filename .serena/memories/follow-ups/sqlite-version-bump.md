# Follow-up — wa-sqlite builds SQLite 3.53.0; the stable is 3.54.1 (2026-11-16)

**Status: DEFERRED** — noted out of curiosity (user, 2026-11-16: "marque de regarder ça en follow-up"); not before the remaining v1 points.

Part of `mem:follow-ups`.

- **Where we are:** wa-sqlite's `Makefile` builds `SQLITE_VERSION = version-3.53.0` (upstream `b0d5ff44`, 2026-04-09, "Update SQLite to 3.53."); the shipped `.wasm` carries source id `2026-04-09 11:41:38 4525003a…`. sqlite.org's latest on 2026-11-16: **3.54.1 (2026-10-16)**, after 3.53.1-3.53.4 (2026-05 to 07) and 3.54.0 (2026-10-09).
- **What 3.54.0 brings (release notes):** "About 4% faster, as measured by counting CPU cycles in the speedtest1 … benchmark using valgrind on Linux x64" — native, not WASM, to measure; query planner: an UPDATE leaves an expression index alone when the indexed value is unchanged, `UNION … LIMIT 1` faster and lighter, better `expr OR TRUE/FALSE`, DISTINCT ignored in an `IN (SELECT …)`. Not ours: Windows SRW locks, `O_TMPFILE` (unix VFS).
- **Fixes we lack, likely weightier than the speed:** 3.53.1-3.53.4 ("mostly coming from AIs"), and 3.54.1's "possible heap-buffer overflow on 32-bit builds" — wasm32 is 32-bit; not checked whether 3.53.0 has the defect or 3.54.0 introduced it.
- **How:** an upstream PR bumping `SQLITE_VERSION` (rhashimoto bumped it himself before), then a repin; not a rebuild of our own (binary `.wasm` in `patches/`). **First:** build wa-sqlite on 3.54.1 in a worktree (Emscripten in the container unverified) and compare `pnpm bench:build` before/after.
