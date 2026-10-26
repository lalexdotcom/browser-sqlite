# Follow-up — A worker terminated with an open sync access handle frees its Web Lock before its file — what #381 leaves open (2026-10-15) — closed 2026-10-23 (#381 and #382 merged and pinned; checked 2026-10-26)

**Status: CLOSED** — 2026-10-23, #381 and #382 merged and pinned.

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

Found through `coopsync-handover` on Windows Firefox (run 38693552137): besides the 30 s open `TIMEOUT`s, 2 × `undefined: No modification allowed` — an error with no `SQLiteError` code. Path: `OPFSCoopSyncVFS.#requestAccessHandle` took the Web Lock, called `createSyncAccessHandle()` ONCE and rethrew; the rejection left the SQLite call as a raw JS exception, which `statementError` (`src/pool.ts`) makes a plain `Error`. Every engine and OS has the race; Windows Firefox widens the window tenfold (HANDOVER-PROBE, `mem:measurements/held-handles`).

**Fixed for `OPFSCoopSyncVFS` by rhashimoto/wa-sqlite#381** (retry every 10 ms up to 5 s; report `docs/upstream/2026-10-15-wa-sqlite-381-coopsync-held-handle.md`), **merged and pinned on 2026-10-23** (`8a8bc2ee`; `mem:stack-and-build/wa-sqlite`); on Windows Firefox two CoopSync clients then fail no statement (COOPSYNC-381-WINDOWS). The library's first-open retry it made redundant is removed (POST-381, `mem:measurements/held-handles`).

**Open:**
- **`OPFSAdaptiveVFS`: the same race, worse — rhashimoto/wa-sqlite#382 opened 2026-10-16, merged 2026-10-23 (`010eeb50`), pinned at `66336807`; its fork branch deleted 2026-10-26** (was `opfsadaptive-retry-held-handle`, head `d6dd6ba0`; report `docs/upstream/2026-10-16-wa-sqlite-382-adaptive-held-handle.md`, numbers ADAPTIVE-382 in `mem:measurements/held-handles`). Without `readwrite-unsafe` (Firefox, Safari) a held file in `jLock()` left the lock held with no handle: on Firefox `asyncify` hung B and every other connection, `jspi` failed raw and B's `close()` never returned. The change retries as #381 does and gives the lock back on failure; **carried as a `pnpm patch` beside #381 since 2026-10-16.** Upstream's other lock-then-file sites, surveyed: none left (ADAPTIVE-382).
- The throwaways are removed: the fork's `probe/held-handle` branch deleted; `scripts/probe-handover.ts` last at `6050a53`, `scripts/probe-opfs.ts` at `6ec7616`, both on `ci/windows-macos` (`git show <sha>:<path>` to rerun).
