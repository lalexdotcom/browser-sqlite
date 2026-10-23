# Follow-up — a restarted worker meets the file its crashed predecessor still holds (`lifecycle`, Firefox `OPFSAdaptiveVFS/jspi`)

Part of `mem:follow-ups`, opened 2026-10-21. **Fixed on `fix/restart-held-file` (2026-10-21, the user's option A); what stays open is Safari, below.**

**What failed:** run 39620037006 (`xcode-27`, macOS 27.0.1, Firefox 155.0.1, `main` `7108558`), `tests/browser/pairs/lifecycle.test.ts` › "worker lifecycle — crash detection › restarts the slot once and keeps serving": the replacement's open failed with `WORKER_CRASHED: unable to open database file: NoModificationAllowedError`, in 411 ms (no retry ran).

**Cause, by elimination and in the code:** `handleDeath` terminates the dead worker and spawns its replacement in one synchronous pass (`src/client.ts`). Without `readwrite-unsafe`, `OPFSAdaptiveVFS`'s `jOpen` takes the file's Web Lock, then an exclusive handle; a terminated worker gives the lock back before the file (wa-sqlite #381), so the replacement can get the lock and meet the file held. `jOpen` returns `SQLITE_CANTOPEN` with the error in `lastError` (it has no held retry; `jLock` got one with #382), and `openWithRetry` kept the VFS out of its retry (`exclusiveFileHandle: false`). Each test has its own file and a pool of one, so the only possible holder was the corpse. Rare: 1 of 6 full suites on `xcode-27`, 0 on `macos-26`, 0 of 130 looped runs, no near-miss in 3 probed suites (LIFECYCLE-HELD-PROBE, `mem:measurements/ci-runners`).

**The fix:** the pool tells a worker spawned after a death (`afterDeath` in the `open` message: the restart and the startup retry round), and its `openWithRetry` retries a held file whatever the declaration; a first open keeps the declaration (HELD-LIVE). Test: `open-retry.test.ts` › "reopening a database after its worker died" (`vfs:OPFSAdaptiveVFS`, `browser:firefox`) kills the worker with `killSilently`, holds the file as the corpse would (handle, no lock, released 200 ms after the VFS's `OPFS:/<path>` announcement), then dispatches the crash; without the fix it fails 3/3 with CI's exact error.

**Still open:**
- **Safari:** WebKit's `InvalidStateError` is matched since `fix/safari-held-file` (2026-10-22, `src/worker/held.ts`), so the `afterDeath` retry runs there too. What still keeps a Safari restart from opening is a killed worker inside a long statement that keeps running (WebKit 328618; `mem:follow-ups/safari-suite`).
- **`OPFSWriteAheadVFS` on Firefox** keeps three exclusive handles for its life without `readwrite-unsafe`, so its restart can meet them too; covered by the fix (every VFS), neither observed nor tested.
- Upstream: `jOpen` could get #382's held retry; not proposed (the user's call).
