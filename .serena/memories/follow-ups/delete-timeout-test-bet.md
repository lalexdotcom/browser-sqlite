# Follow-up — `delete.test.ts`'s `WORKER_TIMEOUT` test bets on a duration

**Status: OPEN** — seen 2026-11-13, not diagnosed beyond reading the test.

Part of `mem:follow-ups`.

- **Seen:** macOS 26 matrix on `test/close-immediate-safari` (run 43462109531, cancelled afterwards), cell `firefox · OPFSWriteAheadVFS/sync`: `delete.test.ts` › "rejects with WORKER_TIMEOUT once its timeout is spent" — "promise resolved "undefined" instead of rejecting".
- **Why it can pass the deletion through:** the test hands `deleteDatabase()` `timeout: 1` and expects the deletion to take longer (`feat/delete-timeout`, 2026-11-12, `mem:history/2026-11-09-to-15`). Since `fix/delete-without-vfs` (2026-11-06) a VFS with a folder (`OPFSWriteAheadVFS` among them) is deleted without a worker, so the deletion can end before a 1 ms timer fires. That is a *duration bet* (`mem:follow-ups/time-based-tests`). Not checked: whether the test is placed on such VFS on purpose, and how the deadline is armed on that path.
- **Also seen in the same campaign, unrelated:** macOS 27 `isolated-safari · MemoryVFS/sync`, `early-exit.test.ts` › "a break out of chunk() cuts the step it left running" — not exercised ("the count was not computing before the break"); the pair green.
