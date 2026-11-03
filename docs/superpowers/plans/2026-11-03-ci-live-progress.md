# Live Progress of CI Test Runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each planner run on CI publishes a GitHub check run whose summary shows its `[n/N]` lines and every failed test as it happens; `scripts/ci-watch.ts` follows those check runs from a terminal.

**Architecture:** A live Vitest reporter in every process the planners spawn appends each failed test to a per-job NDJSON events file. `scripts/ci-progress.ts` (the only writer) creates the check run, reads the events files and the planner's `[n/N]` lines, and PATCHes the summary when something changed, at most every 10 s; the planner closes it with its verdict, and a workflow step in `if: always()` closes any left open with `job.status`. `scripts/ci-watch.ts` polls the commit's check runs through `gh api` and prints what is new.

**Tech Stack:** Node 24 (type stripping, global `fetch`), Vitest 5.0.3 reporter API, GitHub Checks REST API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-ci-live-progress-design.md`

## Global Constraints

- Publishing is on only when `CI === 'true'` and `GITHUB_TOKEN`, `GITHUB_REPOSITORY` are set; otherwise every entry point is a no-op and the planners behave exactly as today.
- A publishing failure never changes a planner's exit code or report: warn once (`ci-progress: publishing stopped: <reason>`), then no further request.
- No network call on the path that starts or ends a cell; the pool never awaits a request. Only `finish()` awaits, bounded (15 s).
- A PATCH only when something changed, at most one per 10 s; no annotations, ever.
- Check run name: `progress · <GITHUB_WORKFLOW> · <BSQ_PROGRESS_LABEL ?? GITHUB_JOB> · <phase>`; `external_id`: `<GITHUB_RUN_ID>/<GITHUB_RUN_ATTEMPT>`; `head_sha`: `BSQ_PROGRESS_SHA ?? GITHUB_SHA`.
- `output.summary` ≤ 65 535 characters, failures before job lines, overflow as `- … and N more`.
- Conclusion: `success` / `failure` from the planner's exit status; the closing step uses `job.status`.
- No new dependency, dev or runtime. Requests carry `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- Repository rules: Serena for code; after each task `pnpm exec biome ci .`, `pnpm lint` (0 warnings), `pnpm exec tsc --noEmit`, `pnpm test:unit`; `node scripts/actionlint.ts` after any workflow change. Commits follow Conventional Commits with the `Co-Authored-By` line. Nothing is pushed without the user's explicit go.

## Review Focus

- A fork's pull request: the token cannot write checks (403 on create) → nothing published, one warning, the run's outcome untouched. Test in Task 2.
- The API hangs at the end of a run → `finish()` gives up after its bound and the planner exits with its own status. Test in Task 2.
- A test name or error message with newlines, backticks or a leading `- ` → still one line in the summary, and `ci-watch.ts` reads it back as one failure. Tests in Tasks 1 and 6.
- An events line read while its writer is mid-write → not parsed, picked up whole at the next read. Test in Task 2.
- A broken build that fails every test (thousands of failures) → summary within the limit, failures first, the overflow counted. Test in Task 1.

---

### Task 1: Summary model and rendering

**Files:**
- Create: `scripts/ci-progress.ts`
- Test: `tests/unit/tooling/ci-progress.test.ts`

**Interfaces:**
- Produces (exported from `scripts/ci-progress.ts`):
  - `type Failure = { job: string; file: string; test: string; message: string }`
  - `type Conclusion = 'success' | 'failure'`
  - `type ProgressState = { started: Date; total: number; lines: string[]; failures: Failure[]; conclusion?: Conclusion }` — `lines` are the planner's `[n/N] …` lines; `lines.length` is the count of ended jobs.
  - `const SUMMARY_LIMIT = 65_535`
  - `function checkRunName(workflow: string, label: string, phase: string): string`
  - `function renderSummary(state: ProgressState): { title: string; summary: string }`
  - `type ProgressConfig = { api: string; repo: string; token: string; sha: string; name: string; externalId: string }`
  - `function progressConfig(env: NodeJS.ProcessEnv, phase: string): ProgressConfig | undefined`

The summary format is a contract with Task 6's parser:

```
**Running** · 3/27 jobs ended · started 08:46:10 UTC      ← or **Done: success** / **Done: failure**

### Failed tests (2)
- `chrome__OPFSWriteAheadVFS__sync` · `tests/browser/x.test.ts` › suite > name — Error: first line

### Jobs
- [1/27] unit: exit 0 in 5s
```

Title: `3/27 · 2 failed` (or `3/27` with no failure; `done · 27/27 · 2 failed` when concluded). Each bullet's variable parts have `\r?\n` replaced by ` ⏎ ` so a bullet is one line.

- [ ] **Step 1: Write the failing tests** in `tests/unit/tooling/ci-progress.test.ts`, `describe('renderSummary')`, `describe('checkRunName')`, `describe('progressConfig')`:
  - `checkRunName('Tests (macOS 27)', 'xcode-27', 'test')` → `'progress · Tests (macOS 27) · xcode-27 · test'`.
  - running state, 3 lines of 27, 2 failures → summary starts with `**Running** · 3/27 jobs ended · started `, contains `### Failed tests (2)` before `### Jobs`, title `'3/27 · 2 failed'`.
  - `conclusion: 'failure'` → summary starts with `**Done: failure**`.
  - a failure whose `test` is `'a\nb'` and message `'x\r\ny'` → its bullet is a single line containing `a ⏎ b` and `x ⏎ y`.
  - 3 000 failures with 100-character messages and 30 lines → `summary.length <= SUMMARY_LIMIT`, it contains `### Failed tests (3000)`, a line matching `/^- … and \d+ more$/m`, and `### Jobs` still present.
  - `progressConfig({ CI: 'true', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', GITHUB_SHA: 's', GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'test', GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '2' }, 'test')` → `{ api: 'https://api.github.com', repo: 'o/r', token: 't', sha: 's', name: 'progress · CI · test · test', externalId: '9/2' }`; with `BSQ_PROGRESS_SHA: 'h'` and `BSQ_PROGRESS_LABEL: 'ubuntu-latest'` → `sha: 'h'`, name `progress · CI · ubuntu-latest · test`; `GITHUB_API_URL` overrides `api`.
  - `progressConfig` returns `undefined` with `CI` unset, with `CI: 'true'` and no `GITHUB_TOKEN`, and with no `GITHUB_REPOSITORY`.

- [ ] **Step 2: Run them to verify they fail**
Run: `pnpm exec vitest run --config tests/vitest.config.ts --project unit tests/unit/tooling/ci-progress.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Implement** the exports above in `scripts/ci-progress.ts`. Truncation: render the failures, if the whole exceeds `SUMMARY_LIMIT` drop job lines from the oldest first, then failures from the last, each group ending in `- … and N more`; the header and both headings always stay.

- [ ] **Step 4: Run the tests to verify they pass** (same command). Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add scripts/ci-progress.ts tests/unit/tooling/ci-progress.test.ts
git commit -m "feat(ci): render a progress summary for CI check runs"
```

### Task 2: The publisher

**Files:**
- Modify: `scripts/ci-progress.ts`
- Test: `tests/unit/tooling/ci-progress.test.ts`

**Interfaces:**
- Consumes: Task 1's types, `renderSummary`, `progressConfig`.
- Produces:
  - `interface Progress { line(text: string): void; finish(conclusion: Conclusion): Promise<void> }`
  - `function startProgress(options: { config: ProgressConfig | undefined; total: number; eventsDir: string; fetch?: typeof fetch; intervalMs?: number; finishTimeoutMs?: number; idsFile?: string; log?: (message: string) => void }): Promise<Progress>` — defaults: `fetch` global, `intervalMs` 10 000, `finishTimeoutMs` 15 000, `idsFile` `join(RUNNER_TEMP, 'bsq-progress-ids')` when `RUNNER_TEMP` is set, `log` `console.log`.
  - `function readEvents(eventsDir: string, offsets: Map<string, number>): Failure[]` — reads every `*.ndjson` in `eventsDir` from its recorded byte offset, parses complete lines only (`{ file, test, message }`, `job` = the file's basename without `.ndjson`), advances the offset past the last complete line.
  - `function closeOpen(ids: readonly string[], conclusion: string, config: Pick<ProgressConfig, 'api' | 'repo' | 'token'>, fetchImpl?: typeof fetch): Promise<void>` — GET each check run, PATCH `{ status: 'completed', conclusion }` when not completed.
  - CLI: `node scripts/ci-progress.ts close <conclusion>` reads the ids file and calls `closeOpen`; exits 0 even when a request fails (it warns).

Behaviour of `startProgress` with a config: POST `/repos/{repo}/check-runs` with `name`, `head_sha`, `external_id`, `status: 'in_progress'`, `started_at`, `output` from `renderSummary`; print `Live progress: <html_url>` through `log`; append the id and a newline to `idsFile`; start an unref'd interval that reads events and, when anything changed since the last send and no request is in flight, PATCHes `output`. `line()` only records and marks dirty. `finish()` clears the interval, reads events a last time, waits for an in-flight request, then PATCHes `status: 'completed'`, `conclusion`, `completed_at`, `output`, all within `finishTimeoutMs` (`AbortSignal.timeout`). Any rejected fetch or non-2xx answer: one `log` line `ci-progress: publishing stopped: <status or message>`, then every method is a no-op. Without a config: a no-op `Progress`, no request, no output.

- [ ] **Step 1: Write the failing tests**, `describe('startProgress')` with a fake `fetch` recording `(url, init)` and answering `{ id: 7, html_url: 'https://github.com/o/r/runs/7' }`, `intervalMs: 20`, a temp `eventsDir` and `idsFile`:
  - creates once with the config's `name`, `head_sha`, `external_id`, `status: 'in_progress'`; logs `Live progress: https://github.com/o/r/runs/7`; the ids file reads `7\n`.
  - `line('[1/2] unit: exit 0 in 5s')` then a wait of 60 ms → exactly one PATCH whose summary contains that line; a further 60 ms with nothing new → no further PATCH.
  - an events file `chrome__A__x.ndjson` gaining `{"file":"f.test.ts","test":"t","message":"boom"}\n` → the next PATCH's summary has a bullet with `` `chrome__A__x` `` and `boom`.
  - `finish('failure')` → last request is a PATCH with `status: 'completed'`, `conclusion: 'failure'`.
  - create answering 403 → one log line starting `ci-progress: publishing stopped: 403`, then `line()` and `finish()` send nothing and `finish()` resolves.
  - a PATCH that never settles at finish, `finishTimeoutMs: 50` → `finish()` resolves within 500 ms.
  - `config: undefined` → no fetch call at all, no log line.
- `describe('readEvents')`: a file holding one complete line and a partial `{"file":"g` → one failure, offset at the end of the complete line; after appending the rest of the line plus `\n`, the next call returns that second failure alone.
- `describe('closeOpen')`: ids `['1','2']`, check run 1 `in_progress`, 2 `completed` → exactly one PATCH, to 1, with `conclusion: 'cancelled'`.

- [ ] **Step 2: Run them to verify they fail** (Task 1's command). Expected: FAIL, `startProgress` not exported.

- [ ] **Step 3: Implement** `startProgress`, `readEvents`, `closeOpen` and the `close` CLI (guarded by `import.meta.url === pathToFileURL(process.argv[1] ?? '').href`, as `scripts/test-matrix.ts` does) in `scripts/ci-progress.ts`.

- [ ] **Step 4: Run the tests to verify they pass.** Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add scripts/ci-progress.ts tests/unit/tooling/ci-progress.test.ts
git commit -m "feat(ci): publish a planner's progress as a check run"
```

### Task 3: The live failure reporter

**Files:**
- Create: `scripts/progress-reporter.ts`
- Modify: `scripts/plan-io.ts` (`openVitest`, the `reporters` list)
- Test: `tests/unit/tooling/progress-reporter.test.ts`

**Interfaces:**
- Produces:
  - `function failureEvent(testCase: { fullName: string; module: { moduleId: string }; result(): { state: string; errors?: readonly { message?: string }[] } }): string | undefined` — for `state === 'failed'`, one JSON line `{"file": <moduleId relative to ROOT>, "test": fullName, "message": <first line of errors[0].message, or ''>}` + `\n`; otherwise `undefined`.
  - default export `class ProgressReporter implements Reporter` whose `onTestCaseResult(testCase)` appends `failureEvent(testCase)` to `process.env.BSQ_PROGRESS_EVENTS` with `appendFileSync`; no-op when the variable is unset.
- Consumers: Task 4 sets `BSQ_PROGRESS_EVENTS` per job and adds `--reporter=./scripts/progress-reporter.ts` on the CLI paths; this task adds `resolve(ROOT, 'scripts/progress-reporter.ts')` to `openVitest`'s reporters whenever it reports (`blob || json`), after `default` and before `blob`.

- [ ] **Step 1: Write the failing tests**: `failureEvent` of a failed case with `moduleId` `join(ROOT, 'tests/browser/x.test.ts')`, `fullName` `'s > t'`, message `'AssertionError: a\n  at b'` → parses to `{ file: 'tests/browser/x.test.ts', test: 's > t', message: 'AssertionError: a' }` and ends with `\n`; a `passed` case and a `skipped` case → `undefined`; a failed case with no `errors` → `message: ''`. The reporter with `BSQ_PROGRESS_EVENTS` pointing at a temp file appends two lines for two failed cases; with it unset writes nothing and does not throw. Extend `tests/unit/tooling/plan-io.test.ts` only if it already asserts `openVitest`'s reporter list; otherwise the wiring is proven by Task 4's run.

- [ ] **Step 2: Run them to verify they fail**
Run: `pnpm exec vitest run --config tests/vitest.config.ts --project unit tests/unit/tooling/progress-reporter.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** `scripts/progress-reporter.ts` (header comment in the style of `scripts/skip-notes.ts`) and add it to `openVitest`.

- [ ] **Step 4: Run the tests to verify they pass**, then `pnpm test:unit`. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add scripts/progress-reporter.ts scripts/plan-io.ts tests/unit/tooling/progress-reporter.test.ts
git commit -m "feat(ci): report each failed test to the planner as it fails"
```

### Task 4: Wire the planners

**Files:**
- Modify: `scripts/test-plan.ts` (`main`, run phase), `scripts/test-parallel.ts` (`main`)

**Interfaces:**
- Consumes: `progressConfig`, `startProgress` (Task 2); `ProgressReporter` path (Task 3).
- Phase: `test-plan.ts` → `'test'`; `test-parallel.ts` → `'conformance'` when every matched project name starts with `conformance `, else `'parallel'`.

- [ ] **Step 1: Wire `test-plan.ts`.** After the run directory exists and `jobs` is known (not under `--plan-only`, which returns earlier): `events = join(run, 'events')`, created; `const progress = await startProgress({ config: progressConfig(process.env, 'test'), total: jobs.length, eventsDir: events })`. Each job's env becomes `{ ...jobEnv(env, job.id), BSQ_PROGRESS_EVENTS: join(events, `${job.id}.ndjson`) }`. The unit job's CLI args gain `--reporter=./scripts/progress-reporter.ts` beside `--reporter=blob`. The `[n/N]` string is built once, passed to `console.log` and to `progress.line()`. Before `process.exitCode = status` at the end: `await progress.finish(status === 0 ? 'success' : 'failure')`.
- [ ] **Step 2: Wire `test-parallel.ts`** the same way: events dir under its `run`, `BSQ_PROGRESS_EVENTS` per job, `--reporter=./scripts/progress-reporter.ts` beside `--reporter=blob`, `progress.line()` with the `[n/N]` line, `finish` before `process.exitCode = status`.
- [ ] **Step 3: Verify nothing changes locally.** Run: `pnpm test` then `pnpm test:conformance`. Expected: green, the same counts as the last run on `main`, no `Live progress` line, and each `.work/test-parallel/<run>/events/` empty.
- [ ] **Step 4: Verify a failure reaches the events file.** Add a throwaway `tests/unit/zz-progress-probe.test.ts` with `it('fails', () => expect(1).toBe(2))`, run `pnpm test`; expected: red, and the run's `events/unit.ndjson` holds one line naming `tests/unit/zz-progress-probe.test.ts` and `fails`. Delete the probe file.
- [ ] **Step 5: Verify the CI path without a token is silent.** Run: `CI=true pnpm test` (no `GITHUB_TOKEN` in this container's environment; check with `printenv GITHUB_TOKEN` first and unset it for the command if present). Expected: no `Live progress` line, no `ci-progress` warning, green as in Step 3.
- [ ] **Step 6: Commit**
```bash
git add scripts/test-plan.ts scripts/test-parallel.ts
git commit -m "feat(ci): planners publish their progress on CI"
```

### Task 5: Workflows

**Files:**
- Modify: `.github/workflows/tests.yaml`, `.github/workflows/matrix.yaml`, `.github/workflows/ci.yaml`, `.github/workflows/tests-ubuntu.yaml`, `.github/workflows/tests-windows.yaml`, `.github/workflows/tests-macos-26.yaml`, `.github/workflows/tests-macos-27.yaml`, `.github/workflows/release-and-publish.yaml`

The repository's default token permission is `read` (checked 2026-11-03), and a called workflow's job cannot exceed its caller: every caller in the chain must grant `checks: write` in the same commit, or the called workflow refuses to start.

- [ ] **Step 1: `tests.yaml`, job `test`:** `permissions: { contents: read, checks: write }`. On the `Test` and `Conformance` steps, `env`: `GITHUB_TOKEN: ${{ github.token }}`, `BSQ_PROGRESS_SHA: ${{ github.event.pull_request.head.sha || github.sha }}`, `BSQ_PROGRESS_LABEL: ${{ inputs.runs-on }}`. Last step:
```yaml
      # A cancelled or timed-out job, or a planner killed by bounded.ts, leaves
      # its progress check run open: close it as the job ended.
      - name: Close progress
        if: always()
        env:
          GITHUB_TOKEN: ${{ github.token }}
          CONCLUSION: ${{ job.status }}
        run: |
          [ -s "$RUNNER_TEMP/bsq-progress-ids" ] || exit 0
          node scripts/ci-progress.ts close "$CONCLUSION"
```
- [ ] **Step 2: `matrix.yaml`, job `cells`:** the same permissions; the same `env` on the `Matrix …` step with `BSQ_PROGRESS_LABEL: ${{ matrix.pair }}`; the same closing step, after `Matrix report`. Job `plan` unchanged.
- [ ] **Step 3: Callers.** `ci.yaml` job `linux`, the calling job of each `tests-<os>.yaml`, and `release-and-publish.yaml` jobs `verify` and `matrix`: `permissions: { contents: read, checks: write }` (the release's two replace their `contents: read`).
- [ ] **Step 4: Lint.** Run: `node scripts/actionlint.ts && pnpm exec biome ci .` Expected: exit 0, no output from actionlint.
- [ ] **Step 5: Commit**
```bash
git add .github/workflows
git commit -m "ci: grant checks: write and close progress check runs"
```

### Task 6: `ci-watch.ts`

**Files:**
- Create: `scripts/ci-watch.ts`
- Test: `tests/unit/tooling/ci-watch.test.ts`

**Interfaces:**
- Consumes: the summary format of Task 1 (headings `### Failed tests (n)` and `### Jobs`, bullets `- `, the `- … and N more` overflow line).
- Produces:
  - `function parseSummary(summary: string): { failures: string[]; jobs: string[] }` — the bullet texts under each heading, overflow lines excluded.
  - `type Snapshot = { name: string; status: string; conclusion: string | null; summary: string }`
  - `function newEvents(seen: Set<string>, snapshot: Snapshot): string[]` — returns, once each, `<name>: FAILED <failure>`, `<name>: <job line>`, and `<name>: done, <conclusion>` when completed; records them in `seen`.
  - CLI (behind the same `import.meta.url` guard as Task 2): `node scripts/ci-watch.ts <run-id> | --sha <sha> [--interval <seconds>]` (default 15). Uses `gh api` (`execFileSync('gh', ['api', …])`), never a token of its own. Run mode: `actions/runs/<id>` gives `head_sha`, `run_attempt`, `status`; sha mode: `actions/runs?head_sha=<sha>` gives the runs. Each poll lists `commits/<sha>/check-runs?filter=all&per_page=100` (`--paginate`), keeps names starting `progress · ` whose `external_id` is `<run id>/<run attempt>` of a followed run, prints `newEvents` lines, and exits 0 once every followed run is `completed` and every kept check run is `completed`, printing `run <id>: <conclusion>` per run last.

- [ ] **Step 1: Write the failing tests:** `parseSummary` of a `renderSummary` output (import Task 1's function) with 2 failures, 3 job lines and a forced overflow → 2 failures (minus the overflow line), 3 jobs; a failure whose test held a newline round-trips as one entry. `newEvents` on the same snapshot twice → the second call returns `[]`; a snapshot gaining one job line → exactly that line; status `completed`, conclusion `failure` → ends with `<name>: done, failure`.
- [ ] **Step 2: Run them to verify they fail**
Run: `pnpm exec vitest run --config tests/vitest.config.ts --project unit tests/unit/tooling/ci-watch.test.ts`
Expected: FAIL, module missing.
- [ ] **Step 3: Implement** `scripts/ci-watch.ts`.
- [ ] **Step 4: Run the tests to verify they pass**, then the full checks (Global Constraints). Expected: PASS, 0 warnings.
- [ ] **Step 5: Commit**
```bash
git add scripts/ci-watch.ts tests/unit/tooling/ci-watch.test.ts
git commit -m "feat(ci): follow a run's progress check runs from a terminal"
```

### Task 7: Prove it on GitHub, record, merge

Every step that pushes or dispatches waits for the user's explicit go.

- [ ] **Step 1: Push the branch (user's go)** and dispatch `gh workflow run tests-ubuntu.yaml --ref feat/ci-live-progress` and `gh workflow run matrix.yaml --ref feat/ci-live-progress`. Follow both with `node scripts/ci-watch.ts <run id>` in the background. Expected: `Live progress: …` in each planner's log; `[n/N]` lines arriving during the run; green runs; every progress check run `completed/success`.
- [ ] **Step 2: A live failure.** A throwaway commit with a failing browser test (one `it` that fails on every cell of one pair), dispatch `tests-ubuntu.yaml`; expected: `ci-watch.ts` prints `FAILED` with the test's name before that cell's `[n/N]` line, and the check run ends `failure`. Revert the commit.
- [ ] **Step 3: Interruptions.** Cancel a dispatched `tests-ubuntu.yaml` by hand mid-`Test`; expected: its check run `completed/cancelled`. Re-run a completed run (`gh run rerun <id>`); record whether the commit's checks show the newer progress check run only (spec Goal 7, unverified).
- [ ] **Step 4: Memories (Serena).** `mem:follow-ups/ci-live-progress` CLOSED with a pointer to the spec; `mem:follow-ups` index updated; `mem:stack-and-build/ci` gains the progress check run, the permissions chain, the closing step and `ci-watch.ts`; the spike's findings (spec § What the spike established) and this task's runs go to `mem:measurements/ci-runners`; `mem:history/2026-11-02-to-08` one line; `mem:state` if it names the follow-up.
- [ ] **Step 5: Merge** (user's go): format, lint, typecheck, tests green; `git switch main && git merge --no-ff feat/ci-live-progress && git branch -d feat/ci-live-progress`. Delete the branch on the remote and the proving runs if the user wants them gone.
