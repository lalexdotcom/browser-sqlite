# The library's tests on Windows and macOS — CI on demand

Date: 2026-10-14. Status: design approved in conversation, awaiting review of this document.

## 1. Why, and what is out

`mem:conventions` (§ Testing in browsers) asks for the library's tests on every platform its users run: Linux and Windows with Chrome and Firefox, macOS with Chrome, Firefox and Safari, each platform startable by hand with its own triggers. Today CI runs Linux only.

The work is split in three, each with its own spec and plan (user, 2026-10-14):

1. **This spec:** Chrome and Firefox on Windows and macOS, dispatched by hand.
2. Safari on macOS — a third browser in the planner, the Vitest projects and the probes; `safaridriver` takes one session per machine and has no headless mode.
3. Safari in the iOS simulator.

Out of this spec as well: putting the new workflows in the release. That comes after they have run well (§ 5.3).

## 2. Decisions (user, 2026-10-14)

- **D1 — One setup procedure, as a composite action, for every workflow.** The steps every browser job repeats today move to `.github/actions/setup/action.yaml`; the platform difference lives in the action (`if: runner.os == …`), not in each workflow.
- **D2 — A reusable test workflow and one small workflow per platform.** `tests.yaml` (`workflow_call`) holds the steps; `tests-windows.yaml` and `tests-macos.yaml` hold only their triggers, so each platform's triggers can differ, as the convention asks. Both are `workflow_dispatch` only for now.
- **D3 — The four existing workflows migrate to the action in this work:** `ci.yaml`, `matrix.yaml`, `release-and-publish.yaml`, and `pages.yaml`. `pages.yaml` stays on `ubuntu-latest`; it migrates for the deduplication only.
- **D4 — A job installs only the browsers it drives.** `pages.yaml`'s bench check and the release's `consumer-smoke` drive Chrome alone, yet today install and open both browsers.
- **D5 — Lists are comma-separated:** the action's `browsers` input, `scripts/browsers.ts install`'s argument, and the cache key all use `chrome,firefox`.
- **D6 — What runs on Windows and macOS is what `verify` tests on Linux:** `pnpm build`, `pnpm test`, `pnpm test:conformance`. Lint, typecheck and the generated-docs check do not depend on the OS and stay in `ci.yaml` alone. A per-OS matrix is not in this work.

## 3. CI structure

### 3.1 The composite action — `.github/actions/setup/action.yaml`

Inputs:

| Input | Default | Meaning |
|---|---|---|
| `browsers` | `chrome,firefox` | browsers to install, comma-separated; empty for none |
| `node-setup` | `true` | set up pnpm and Node and run `pnpm install --frozen-lockfile` |

Steps, in order:

1. When `node-setup` is `true`: `pnpm/action-setup`, `actions/setup-node` (Node 24, `cache: pnpm`), `pnpm install --frozen-lockfile`.
2. When `browsers` is not empty:
   - `actions/cache` on `node_modules/.cache/wdio`, key `wdio-<runner.os>-<runner.arch>-<browsers>-<hash of scripts/browsers.ts>`. The list is in the key: a cache saved by a Chrome-only job and restored for a job that needs Firefox would be downloaded into and never saved, since a hit is not written back.
   - When `runner.os == 'Linux'`: lift `kernel.apparmor_restrict_unprivileged_userns` (Ubuntu 24.04 denies the downloaded Chrome for Testing its sandbox otherwise; the existing comment moves with the step).
   - `node scripts/browsers.ts install <browsers>`.

Every `run:` step declares `shell: bash` — required in a composite action, and it keeps Windows off PowerShell (Git Bash is on GitHub's Windows images).

The checkout stays in each job, before the action: a local action is read from the checked-out tree.

### 3.2 The reusable workflow — `.github/workflows/tests.yaml`

`on: workflow_call` with one input, `runs-on` (string). One job, `test`, `runs-on: ${{ inputs.runs-on }}`, `timeout-minutes: 90`: checkout, the action with its defaults, `pnpm build`, `pnpm test`, `pnpm test:conformance`.

### 3.3 The per-platform workflows

`tests-windows.yaml` and `tests-macos.yaml`: `on: workflow_dispatch`, one job calling `./.github/workflows/tests.yaml` with `runs-on: windows-latest` / `macos-latest`, `concurrency: tests-<platform>-${{ github.ref }}` with `cancel-in-progress: true`.

### 3.4 The migration

| Workflow | Job(s) | Action inputs | What else changes |
|---|---|---|---|
| `ci.yaml` | `verify` | defaults | nothing; it keeps its lint, docs, typecheck, build and test steps and does not call `tests.yaml` |
| `matrix.yaml` | `plan`, `cells` | defaults | nothing |
| `release-and-publish.yaml` | `consumer-smoke` | `browsers: chrome` | nothing |
| `pages.yaml` | the build job | `browsers: chrome`, `node-setup: false` | keeps its own `setup-node` and its `pnpm install` in each tag checkout; only the browser block moves to the action |

### 3.5 Dispatching a workflow that is not on `main` yet

GitHub accepts a `workflow_dispatch` only for a workflow file present on the remote's default branch. To run `tests-windows.yaml` and `tests-macos.yaml` from the branch before the merge, the branch carries a temporary `push` trigger on itself in both files, removed before the merge (recommended), unless the user prefers to push `main` with the two files first. Either needs the user's go to push.

## 4. Portable scripts

macOS behaves like Linux for everything below: POSIX process groups and signals. Only `win32` branches.

Both helpers below live in a new `scripts/processes.ts`, imported by `scripts/parallel.ts`, `scripts/bounded.ts` and `tests/harness/build-setup.ts`.

### 4.1 Killing a process tree

A shared `killTree(pid)`:

- POSIX: `process.kill(-pid, 'SIGKILL')`, `ESRCH` ignored — today's behaviour.
- `win32`: `taskkill /T /F /PID <pid>`, synchronous, so the child and everything it started go.

Used by `runBounded`'s timer, by `killLive` (Ctrl-C, CI cancellation), and by `scripts/bounded.ts`, which on Windows killed only its direct child — a Vitest or a browser started below it survived the deadline. Signals other than `SIGKILL` do not exist on Windows: there, both the deadline and a received signal go through `taskkill /F`. `detached: true` stays on POSIX (it makes the group); on Windows it opens a new console and buys nothing, so it is `false` there.

### 4.2 Starting `pnpm` and `npx`

On Windows `pnpm` and `npx` are `.cmd` files, and Node refuses to spawn one without `shell: true` (`EINVAL`, since the CVE-2024-27980 fix). A shell is no answer on the path CI runs: the Vitest invocations pass project names with spaces (`chrome · OPFSAdaptiveVFS/jspi`), which `cmd.exe` would split (amended 2026-10-14, while planning).

- **The CI path — Vitest and rslib — runs their package's bin with Node:** `packageBin(pkg, bin)` reads `node_modules/<pkg>/package.json`'s `bin` and returns `[process.execPath, <absolute path of the bin>]`. No `.cmd`, no shell, the same on every OS, so no `win32` branch. It replaces every `pnpm exec vitest …` and `pnpm exec rslib …` in `scripts/test-parallel.ts`, `scripts/test-plan.ts`, `scripts/parallel.ts` (`buildOnce`) and `tests/harness/build-setup.ts`.
- **`scripts/hook-gate.ts`, which runs locally only (git hooks), keeps `pnpm`/`npx` with `shell: true` on `win32`.** Its argv are constants of the code without whitespace or quotes — a unit test holds that — so the shell can neither split them nor open an injection.

Commands that start with `node` need nothing.

### 4.3 `scripts/browsers.ts`

- `install [list]`: a comma-separated list, `chrome,firefox` when omitted; an unknown name exits with an error naming the valid ones. Each named browser is downloaded and a session opened and closed, as today.
- `deps` stays Linux-only (apt), and says so when called elsewhere.

### 4.4 Paths

Scripts that run in CI are checked for hard-coded `/` separators; `file://` URLs and `path.join` are already portable. What breaks on Windows is fixed when the first run shows it — no speculative rewrite.

## 5. What runs, proof, and success

### 5.1 A run

`pnpm build`, `pnpm test`, `pnpm test:conformance`, with the same pins as Linux (Chrome 153, Firefox 155 — `scripts/browsers.ts`). Parallelism stays `min(6, CPUs - 1)`: 3 jobs on `windows-latest` (4 vCPU), 2 on `macos-latest` (3 vCPU). The scripts' bounds stay (2400 s for `pnpm test`, 1800 s for conformance), the job's is 90 min; if Windows exceeds one at the first run, it is measured and adjusted with the figure, not raised in advance.

### 5.2 Success

- Each dispatched workflow is green.
- Its counts match Linux's: same browsers, same probed features, so the same plan. The "Skipped with a reason" list and the "Not applicable" counts are compared too. Any difference is a signal to look at, not noise.
- **3 green runs per platform**, with their durations recorded in `mem:measurements`, before the release integration is discussed (§ 5.3).

### 5.3 Proof of the Linux migration

- `ci.yaml` and `matrix.yaml`: the push of `main` that carries the merge.
- `pages.yaml`: the next push of the `preview` tag.
- `release-and-publish.yaml` (`consumer-smoke`): the next release.

The last two stay open in `mem:stack-and-build/ci` until they have run.

### 5.4 Local verification before any push

actionlint on every workflow and the action; `pnpm test:unit` (with the new unit tests of `browsers.ts install`'s list) and `pnpm test` green on Linux, showing the script changes left POSIX unchanged. The `win32` branches cannot run here; the Windows run is their proof, since `pnpm test` goes through `bounded.ts` there.

## 6. Tests

- `tests/unit/tooling/`: `browsers.ts install`'s list parsing (default, one name, two, an unknown name, empty entries).
- `bounded.test.ts` keeps its POSIX cases (the zombie grandchild); the `win32` path is proven by the Windows run (§ 5.4).

## 7. Documentation and memory

- README, development section: `pnpm test` runs on Linux, Windows and macOS (Chrome and Firefox); the Windows and macOS workflows are dispatched by hand.
- No CHANGELOG entry: nothing a consumer sees changes.
- Memory: `mem:stack-and-build/ci` (the action, the new workflows, what stays to prove), `mem:conventions` (§ What runs where), `mem:measurements` (the runs' durations and counts).
