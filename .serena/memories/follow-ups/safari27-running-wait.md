# Follow-up — on Safari 27, a long statement of the routing tests is never seen running

**Status: OPEN** — found 2026-10-28 on the first macOS 27 runs after `feat/sqlite-routing`'s merge; cause unknown, diagnosis not started.

Part of `mem:follow-ups`.

**What fails.** `tests-macos-27.yaml` on `main` `7cb5122`, twice (runs 40712191843 and 40719361310): tests added by the routing branch that wait with `waitUntil(theQueryIsRunning(db, sql))` (`tests/browser/helpers/index.ts`: a request without `endTime` whose worker's debug status is `RUNNING` and whose last query has the statement's text) time out at 10 s (5 s × `BSQ_TIME_SCALE=2`) on Safari 27, on `OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi`. Run 1: `tx-stream` "a savepointed tx.stream() write aborted before affected is undone…" on both pairs, `stream-write` "an abort while the worker steps the write rolls it back" (Adaptive), `verdict` "waits for a query stepping on the worker" (Adaptive). Run 2: the `tx-stream` test on both pairs, the `verdict` test on WriteAhead. The rest of the suite passes on Safari 27 (559 of 562 files).

**What does not fail.** The same tests pass on Safari 26.6.2 (`tests-macos-26.yaml`, run 40712185970), in 0.4-3 s, so the statement is seen running there; older tests using the same helper with longer statements (`interrupt.test.ts`, 20-40 M iterations) pass on Safari 27. macOS 27 was green before the branch (push of `a17b6c6`, 2026-10-26). Chrome and Firefox on every OS green, the matrix 23/23.

**Not known yet:** whether on Safari 27 the statement never starts (a verdict or a lease waiting), or runs without `db.debug` showing it `RUNNING`, or ends before it is polled. A first guess — the failing tests' statements are short (1-2 M iterations) and Safari finishes them unseen — is weakened by Safari 26 seeing them at once.

**Alone, it does not reproduce (spike run 40725890211, 2026-10-28).** One spike file, one Vitest process per project: on Safari 27.0.1, `OPFSWriteAheadVFS/sync` and `OPFSAdaptiveVFS/jspi` — the failing pairs — see a cold 2 M-step `all()`, the same warm, and a savepointed `tx.stream()` write running in 11-14 ms, a 20 M-step read in ~100 ms; Safari 26.6.2 alike. So the verdict, the read, the streamed write and `db.debug`'s view all work there: **the failure needs the suite's context** (earlier files or tests of the cell). Aside: on the `async` build (Safari 26 and 27), the third client of that file (a cold 20 M-step read) got its request only 4-9 s after the call — something earlier in the file held it; not investigated.

**In flight:** the two failing cells run whole through the planner, with `waitUntil` printing the debug history of a `theQueryIsRunning` that times out (branch `spike/safari27-running-wait`, run 40727661900).

**Next, recommended:** a diagnostic branch whose spike prints `db.debug`'s request/worker state live to the step log while it waits, on macOS 27 only (`mem:conventions`: spikes are observable), before changing code or tests. macOS 27 runs on the `xcode-27` preview image (`mem:stack-and-build/ci`).
