# Follow-up — Reading a GitHub run's progress from `gh` while it runs (user, 2026-10-26)

**Status: OPEN** — not designed; the recommended mechanism is a progress check run the planner updates.

Part of `mem:follow-ups`, opened 2026-10-26 (user), while following the OS workflows of the push of `main` `a17b6c6`.

**The gap.** While a job runs, Claude can read only job and step status: `gh run view --log` answers "run … is still in progress; logs will be available when it is complete", and `gh api repos/{owner}/{repo}/actions/jobs/{id}/logs` answers 404 `BlobNotFound` (both checked 2026-10-26 on run 40349652033). On the OS workflows (`tests-windows.yaml`, `tests-macos-26.yaml`, `tests-macos-27.yaml`) the whole suite is one step, `Test`, so for 25-35 min the only visible state is "Test in progress" — the planner's `[n/27] <cell>: exit … in …s` lines exist only in the web UI's live log (the user pasted them by hand).

**What exists (searched 2026-10-26).** `gh run watch` shows job and step status, never logs; a gh maintainer (cli/cli Discussion #11893, October 2025) says streaming logs is long in the backlog and blocked on the API, which has no log streaming. The documented way to expose progress during a run is the **Checks API**: the workflow's token can create its own check run `in_progress` and PATCH its `output` (title, summary) and annotations as it goes (annotations append per update, 50 per request) — then `gh api repos/{owner}/{repo}/check-runs/{id}` reads it live. Whether `::notice::`/`::warning::` workflow-command annotations become readable through the API before their step or job ends is undocumented.

**Options.**
- **Recommended:** the planner (`scripts/test-plan.ts` / `scripts/test-parallel.ts`), when it runs on CI, creates a check run "progress" and PATCHes its summary at each cell end with the `[n/N]` line; the workflow needs `permissions: checks: write`. Claude polls the check run.
- `::notice::` per cell end: simpler, but measure first whether the API returns the annotations during the run.
- One step (or job) per cell in the OS workflows: step status is readable live, at the cost of a more verbose workflow and of the planner's single merged report.

Sources: cli/cli Discussion #11893; GitHub Docs "Using workflow run logs"; Ken Muse, "Creating GitHub Checks"; tgrall, "Checks and Annotations API"; the "GitHub Checks" Marketplace action; GitHub changelog 2024-10-01 (annotations in the log view).
