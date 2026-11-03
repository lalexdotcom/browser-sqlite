# Live progress of CI test runs, readable while they run

Date: 2026-11-03. Branch: `feat/ci-live-progress`. Background: `mem:follow-ups/ci-live-progress` (opened 2026-10-26), brainstorming of 2026-11-03, the throwaway branch `spike/check-progress` (runs 41605727971 and 41605727832, findings below).

## Why

While a GitHub job runs, its log cannot be read through the API: `gh run view --log` answers "still in progress" and the jobs' logs endpoint answers 404 until the job ends. Only job and step status are visible. On the OS workflows the whole suite is one step, `Test`, so for 25-35 minutes the only state readable from `gh` is "Test in progress"; the planner's `[n/N] <job>: exit … in …s` lines exist only in the web UI's live log, and the user has had to paste them by hand.

The user wants Claude to be able to **monitor a run while it runs** — follow each job's progress and **learn at once when a test fails**, by name, without waiting for the end of its cell (a big cell takes 8-14 minutes on macOS) — and relay it. Claude is the main reader (user, 2026-11-03). The user may follow the same progress on GitHub through a link; that is secondary.

## What the spike established (2026-11-03, `spike/check-progress`)

1. **A check run created by a job's own `GITHUB_TOKEN` (`permissions: checks: write`) is readable live.** Its title, summary and annotation count, PATCHed every 10 s, were read back by `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` polled every 15 s with no visible lag.
2. **`::notice::` workflow-command annotations are NOT readable during the job.** The job's annotations endpoint returned 0 for the whole job, including two minutes after the step that emitted them had ended; 11 of the 12 appeared at once when the job completed. Rejected as a mechanism.
3. **An `if: always()` step runs after a job timeout and after a run cancel**, `job.status` is `cancelled` in both, and it closed the check run as `cancelled`. The job's own (native) check also reads `cancelled` after a timeout — with an annotation "The job has exceeded the maximum execution time of …" — never `timed_out`.
4. **GitHub attaches a check run created this way to a check suite of its choosing, not necessarily the creating workflow's.** All three created check runs, workflow A's included, landed in workflow B's suite; the user saw A's annotations on B's run page and none on A's. Consequence: nothing created here may show on a run page as if it belonged there (no annotations, below), and the way in is a link printed in the job's own log.
5. **There is no API to delete a check run** (REST docs: create, get, update, list, annotations, rerequest). Whatever is created stays on the commit.

## Goals

1. **Every planner invocation on CI publishes one progress check run** — `scripts/test-plan.ts` (`pnpm test`, and each pair of the matrix through `scripts/test-matrix.ts`) and `scripts/test-parallel.ts` (the conformance step). Covered thereby: `ci.yaml`'s `linux` job, every `tests-<os>.yaml`, `matrix.yaml`'s `cells`, and the release's calls of `ci.yaml` and `matrix.yaml` — on push of `main`, on a release and on `workflow_dispatch` on any branch (user, 2026-11-03). `test-plan.ts --plan-only` (`matrix.yaml`'s `plan` job) publishes nothing: it runs no cell.
2. **Its summary carries, updated during the run:**
   - a header: running / done, `n/N` jobs ended, the start time (no ticking elapsed time: Constraints, rate limit);
   - **every failed test as soon as it fails** (user, 2026-11-03): the planner job it ran in (cell or shard), the file, the test's full name, the first line of its first error — the failures first, before anything else;
   - the planner's `[n/N]` lines as they are printed today, in order.
3. **Its conclusion mirrors the job's native check (user, 2026-11-03):** `success` when the planner exits 0, `failure` when it exits non-zero, and otherwise what the job itself ends as — `cancelled` when the job is cancelled or times out, `failure` when the planner is killed under a job that goes on to fail (`bounded.ts` ending the conformance step) — closed by a workflow step (Goal 5).
4. **Its link is printed in the job's log** as soon as the check run exists, on a line of its own that names it as the live progress, so the user reaches it from the running job's live log (user, 2026-11-03: "ça me va").
5. **No check run stays `in_progress`.** Every job that runs a planner ends with an `if: always()` step closing any check run that job created and left open, with `job.status` as its conclusion (`cancelled` after a cancel or a timeout, `failure` after a killed planner; spike finding 3: `job.status` is `cancelled` in both interrupted cases) — my call, 2026-11-03, after the builder check. The planner records each check run it creates so that step can find them; it attempts no PATCH from a signal handler.
6. **`scripts/ci-watch.ts` lets Claude follow a run from a terminal.** Given a workflow run id (or a commit SHA), it polls the API about every 15 s, prints each new `[n/N]` line and each new failure once, prefixed by the check run's name, and exits when the run is completed and every progress check run of it is completed. Its output is plain lines, one event per line, meant for a background monitor. It runs with the local `gh` token, not a job's `GITHUB_TOKEN`.
7. **The check run's name tells jobs apart**: `progress · <workflow> · <job label> · <phase>`, where the job label distinguishes what `GITHUB_JOB` alone does not (the matrix pair; the runner label of `tests.yaml`, so macOS 26 and 27 differ) and the phase is `test` or `conformance` (or the script's equivalent naming). **The name carries no run id or attempt**, so that a re-run's check run has the same name as the first attempt's and GitHub shows the newer one (unverified: to be seen on a re-run while proving the branch). `ci-watch.ts` finds a run's check runs by that name **and by `external_id`, set to `<GITHUB_RUN_ID>/<GITHUB_RUN_ATTEMPT>`** (my call, 2026-11-03), never by check suite (finding 4): two runs of one workflow on one SHA (a re-run, two dispatches, a push then a dispatch) share names, not ids.

## Non-goals

- **Annotations.** None are created (finding 4: they would show on another workflow's run page, a green CI run displaying the Matrix's failures).
- **Anything local.** Off CI (`CI` not `true`) or without a token, publishing is off and the planner behaves exactly as today.
- **Changing what any job tests, its bounds, its timeouts, its plan or its exit code.** Publication is a side channel.
- **Progress for jobs that run no planner** (`checks`, `consumer-smoke`, `pages.yaml`): their job and step status suffice.
- **A matrix on Windows or macOS** (`mem:follow-ups/matrix-windows-macos`, later). It will be covered for free if its jobs run through the planner.
- **A CHANGELOG entry.** Tooling, not a change a consumer of the package can see (`mem:conventions`: user-visible changes only).

## Anti-goals — a failure even if progress shows

- **A publishing failure that changes a test run's outcome.** The API down, a 403 (a fork's pull request has a read-only token), a rate limit, a malformed response: the planner warns once in its log, stops publishing for the rest of the run, and its exit code and report are what they would have been without publication. A step's `GITHUB_TOKEN` missing is not an error.
- **A planner slowed or blocked by publication.** No network call may sit on the path that starts or ends a cell; updates are coalesced and sent at most every ~10 s, never awaited by the pool.
- **A check run left `in_progress`** on a commit after its job has ended, for any ending (Goal 5).
- **A check run on the wrong commit.** On `pull_request` events `GITHUB_SHA` is the merge commit, which the PR's checks do not show: the workflow passes the head SHA explicitly (`github.event.pull_request.head.sha || github.sha`).
- **Progress that claims more than it knows.** A cell that timed out, errored or left no blob is shown as such, as the `[n/N]` line already says (`timed out`, `NO BLOB`); a failure list is never presented as complete before the planner has ended.

## Decided

- **Mechanism: a check run per planner invocation, its summary PATCHed during the run** (spike findings 1-2; the follow-up's recommended option). Rejected: `::notice::` (finding 2) and one step per cell (loses the planner's single merged report).
- **The planner is the only writer of its check run.** Cells run as separate processes; they report failures to the planner (below), which alone PATCHes. Two writers would overwrite each other's summary (an update replaces `output.summary`).
- **Failures reach the planner through a live Vitest reporter** added to every process the planners spawn: the cell processes (`scripts/run-cell.ts` through `openVitest` in `scripts/plan-io.ts`) and the processes launched on the Vitest CLI (`test-plan.ts`'s unit job, `test-parallel.ts`'s jobs). On each test that ends `failed`, it appends one JSON line to an events file of its own job inside the run directory; the planner reads the new lines of every job's events file on its update tick. A test retried to a pass is not a failure (the reporter acts on the final result).
- **Conclusion mirrors the native check; the check run is closed, never deleted** (findings 3 and 5).
- **The link in the log is the user's way in** (finding 4); Claude finds check runs by commit and name.

## Constraints

- **Permissions.** A called workflow cannot hold more than its caller grants. `checks: write` (beside the existing `contents: read`) is needed in `tests.yaml` and `matrix.yaml` (job level, where the planner runs), and in every caller: `ci.yaml` (no `permissions` block today, so it takes the repository default), `tests-ubuntu.yaml`, `tests-windows.yaml`, `tests-macos-26.yaml`, `tests-macos-27.yaml`, and `release-and-publish.yaml`'s `verify` and `matrix` jobs (today `contents: read` only).
- **Token and SHA reach the planner by environment**, set on the steps that run it: the token (`${{ github.token }}`) and the head SHA (Anti-goals). `GITHUB_REPOSITORY`, `GITHUB_API_URL`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_RUN_ID` are already in a step's environment. The job label is passed explicitly where needed (`${{ matrix.pair }}`, `${{ inputs.runs-on }}`).
- **Node 24's `fetch`**, no new dependency (`mem:state`: `dependencies` absent; dev dependencies are not to grow for this either).
- **GitHub's limits.** `output.summary` is at most 65 535 characters — the summary is truncated with "… and N more" (failures kept before `[n/N]` lines). **`GITHUB_TOKEN` has 1 000 requests per hour per repository, shared by every job** — the release's `prior` job (`gh run list`, `gh run watch`) included. So **a PATCH is sent only when something changed** (a new `[n/N]` line, a new failure, the end), at most one per ~10 s, coalescing what arrives in between; nothing ticks on a timer, and the header shows when the run started rather than a running elapsed time (my call, 2026-11-03, after the builder check). Order of magnitude: one create, one PATCH per cell end at most plus the failures', one close — a `pnpm test` of 16-27 jobs stays under ~40 requests, a matrix pair under ~10, a push of `main` with CI and Matrix together a few hundred at worst.
- **Windows and macOS runners**: everything runs under `shell: bash` as the workflows already do; paths through `node:path`.
- **The repository rules apply**: Serena for code, `biome ci`, `pnpm lint` at 0 warnings, `tsc --noEmit`, actionlint (`node scripts/actionlint.ts`) on every workflow change, unit tests under `tests/unit/tooling/`.

## Left to the builder

- Module boundaries and names (`scripts/ci-progress.ts` and `scripts/ci-watch.ts` are working names), the events file format and location inside the run directory, the environment variable names (`BSQ_*` as elsewhere), how the closing step reads the recorded ids (a file under `RUNNER_TEMP` is the obvious place) and whether it is a composite action or a step repeated in the two workflows.
- The exact summary layout within Goal 2, and the poll interval of `ci-watch.ts` within "about 15 s".
- How the reporter is added on the CLI path (`--reporter` with a path, or the config) as long as the `blob`/`json` reporters and their output are unchanged.
- Unit tests: at least the summary rendering and truncation, the name, the "publishing off" path (no `CI`, no token), the failure path (a rejected `fetch` disables publishing without throwing), and `ci-watch.ts`'s diffing of successive polls. The workflows are proven by runs: a dispatched `tests-ubuntu.yaml` and `matrix.yaml` on the branch, one with a deliberately failing throwaway test to see a failure appear live, and one cancelled by hand to see the closing step.

## After the merge

- `mem:follow-ups/ci-live-progress` CLOSED with a pointer here; `mem:stack-and-build/ci` gains the progress check run, its permissions and the closing step; the spike's findings go into `mem:measurements/ci-runners`.
- The spike branch `spike/check-progress` and its two runs are deleted (user's go given with the spike).
