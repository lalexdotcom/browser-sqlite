# Follow-up — a Windows Chrome cell stops producing output and is cut at the planner's bound (2026-11-09)

**Status: OPEN** — first sighting, cause unknown; act at the next sighting or through a spike (user, 2026-11-09: "crée le backlog").

Part of `mem:follow-ups`, opened 2026-11-09 from the Windows matrix of `fix/idb-open-unknown-error` (run 42622390499, commit `1b71637c`, job 129178882592, pair `OPFSWriteAheadVFS/async`).

**What failed.** `chrome__OPFSWriteAheadVFS__async`: `timed out in 3600s (NO BLOB)` — the planner's per-job bound, not a test's. The cell's own log (artifact `matrix-report-2`, `logs/chrome__OPFSWriteAheadVFS__async.log`, 58 lines) shows 9 of its 68 files finished, in the plan's order, `abandon-gc` to `close.test.ts`, in about a minute; then nothing for ~56 min. The next file in the plan is `concurrency.test.ts` (15 tests), then `cross-tab.test.ts`. No test failed and no Vitest timeout fired, although `testTimeout`/`hookTimeout` are ×4 there (`BSQ_TIME_SCALE=4`): what stalled is presumably the page or the WebDriver session, not one test's await — not established. The Firefox cell of the same pair passed (678 s), and the same Chrome cell had passed on the branch's previous Windows matrix two hours earlier (run 42608153036, 296 s).

**Not the branch's:** the branch's library change is a retry of `createVfsInstance` on an `UnknownError`, which Chrome on an OPFS VFS never raises, and its test change is in `tx-savepoint.test.ts`, not in the files around the stall. Merged anyway on the user's call (2026-11-09).

**Unknown:** which file and test it stalled in (a file is printed only once finished); whether the browser, the driver, the page or the worker hung; how often. No earlier sighting in these memories.

**Next, at the next sighting or in a spike:** have a stalled cell say where it is — the planner could print the tests in flight when it cuts a job at its bound (Vitest's per-test start, or the browser's console), so the next occurrence names its file and test; then loop `concurrency.test.ts` on `windows-latest` Chrome `OPFSWriteAheadVFS/async` under load.
