# Follow-up — The Windows/macOS CI: deferred minors of its final review (2026-10-15) — settled 2026-10-26 (`ci/windows-minors`)

**Status: CLOSED** — settled 2026-10-26 (`ci/windows-minors`).

Part of `mem:follow-ups`; moved out of it on 2026-10-26.

- **Accepted, not fixed (user, 2026-10-26):** `scripts/bounded.ts`'s `finish()` calls `killTree` on the child's PID after it exited, only when `bounded` ended the run itself (deadline or a forwarded signal). POSIX: intended, the group outlives its leader. Windows: `taskkill /T /F` on a PID Windows may have recycled — a narrow window, on a run already failing or cancelled.
- **Fixed:** `scripts/hook-gate.ts` printed DEP0190 on Node 24 under Windows (`shell: true` with an args array). `spawnPlan()` now hands a pnpm/npx `.cmd` shim to the shell as one command line and runs everything else without a shell; unit-tested for `win32` and Linux, falsified by the args-array shape. **CI cannot confirm it:** `tests-windows.yaml` never runs hook-gate (checked 2026-10-26 in run 40304959359's log); its one DEP0190 comes from `pnpm/action-setup`'s "Running self-installer…" step, a third party's, and stays. hook-gate's own path runs only in a developer's Windows hooks; the unit test is the evidence.
- **Fixed:** `tests/unit/tooling/processes.test.ts` › "hands an argument with spaces and a middle dot over intact" spawned Node itself and exercised no project code; deleted (the project's guarantee is `packageBin` without a shell, and hook-gate's argv guard test).
- **Fixed:** the Windows budget, (2400 + 1800) s × 4 = 280 min against a 240-min job: `tests-windows.yaml` now has `timeout-minutes: 300`, so a hung run ends in `bounded.ts` as a failure that uploads its logs instead of a GitHub cancellation with none.
