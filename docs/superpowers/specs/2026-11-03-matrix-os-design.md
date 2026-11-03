# The matrix on Windows and macOS, dispatched by hand

Date: 2026-11-03. Branch: `ci/matrix-os`. Background: `mem:follow-ups/matrix-windows-macos` (opened 2026-10-15, "later"), brainstorming of 2026-11-03.

## Why

Before a release the user wants to be able to say **"tested everywhere"** (user, 2026-11-03): every declared VFS/build pair through every browser and mode it applies to, on Linux, Windows and macOS. Today only Linux runs the matrix (`matrix.yaml`, 52 cells, one job per pair); Windows and macOS run `tests.yaml` — `pnpm test` in complement mode, each pair-bound browser test at least once (~19 cells), plus the unit project, the standalone browser tests and the conformance. The matrix covers the pair-bound tests more widely; it does not run the unit project, the standalone tests or the conformance, which is why Linux runs both.

Today `matrix.yaml` is both the module and its own trigger: it starts by itself on every push of `main`, beside `ci.yaml` rather than inside it, and the release reuses or re-runs it as a second workflow. `tests.yaml` is a module only, called by `ci.yaml` and the `tests-<os>.yaml`.

## Scope (user, 2026-11-03)

**Matrices on Windows, macOS 26 and macOS 27, dispatched by hand**, as the `tests-<os>.yaml` are, and **`matrix.yaml` aligned on `tests.yaml`: a reusable module that `ci.yaml` calls** (user, 2026-11-03), so that the release runs the matrix the same way it runs the tests. How the OS matrices fit with `tests-<os>.yaml` and the release — a gate or not, one workflow per OS or two — is decided later, once they have run.

## Goals

1. **`matrix.yaml` is a reusable module, `workflow_call` only — the model of `tests.yaml` (user, 2026-11-03).** It does what it does today, for whatever runner and browsers it is given. Its callers pass their arguments directly:

   | caller | when | arguments |
   |---|---|---|
   | `ci.yaml`, new job `matrix` | whenever CI runs, no condition (user, 2026-11-03): every push of `main`, every pull request — new: a green PR has passed the matrix, as `main` has — and the release's call of `ci.yaml` | `runs-on: ubuntu-latest`, `fail-fast: true` |
   | `matrix-ubuntu.yaml` ("Matrix (Ubuntu)") | `workflow_dispatch` only, as `tests-ubuntu.yaml` | `runs-on: ubuntu-latest` |
   | `matrix-windows.yaml` ("Matrix (Windows)"), `matrix-macos-26.yaml` ("Matrix (macOS 26)"), `matrix-macos-27.yaml` ("Matrix (macOS 27)") | `workflow_dispatch` only | Goal 7 |

   Each dispatch-only caller has its own concurrency group per ref, `cancel-in-progress: true`, as the `tests-<os>.yaml`. Inside `ci.yaml` the matrix falls under CI's group (`ci-${{ github.ref }}`): a new push of `main` supersedes the previous run, matrix included, as `matrix.yaml`'s own group did; under the release `github.ref` is the tag, so `main` never cancels it. The `checks` and `linux` jobs of `ci.yaml` are unchanged, and the three run in parallel.
2. **Inputs of `matrix.yaml`:** `runs-on` (required), `browsers` (default `chrome,firefox`), `time-scale` (default `'1'`, exported as `BSQ_TIME_SCALE` to both jobs), `timeout-minutes` (the pair jobs', default 25), `plan-timeout-minutes` (the plan job's, default 15) and `fail-fast` (boolean, default `false`, Goal 6). Two timeouts as inputs because a workflow expression cannot multiply.
3. **The plan runs on the target OS with the target browsers.** The probed features (JSPI, `readwrite-unsafe`, sync access handles, Safari's) depend on the browser and the platform: the `plan` job runs on `inputs.runs-on`, installs `inputs.browsers` through the setup action (which enables `safaridriver` when the list names Safari), and passes them to `test-plan.ts` as `--browser` each. Its `pairs.json` therefore lists the pairs with a non-empty cell among those browsers.
4. **Each pair job runs every column of the selected browsers**, both modes: `test-matrix.ts --pair <pair>` with `--engine <b>` and `--engine isolated-<b>` for each browser of the list (`test-matrix.ts` refuses a set of columns that is not a product of browsers and modes). For `chrome,firefox` that is today's four columns.
5. **Safari on both macOS (user, 2026-11-03).** `matrix-macos-26.yaml` and `matrix-macos-27.yaml` pass `browsers: chrome,firefox,safari`: each pair job runs up to six columns. Safari accepts one session per machine; the planner already serialises Safari's cells within a job, and each pair job is its own machine.
6. **`fail-fast` is an optional input, default `false`; the runs that gate pass `true` explicitly (user, 2026-11-03).** Only `ci.yaml`'s `matrix` job passes `true` — which covers the push of `main`, pull requests and the release, all through `ci.yaml`: one red pair cancels the others, as today, each cancelled pair's progress check run closed `cancelled` by the closing step. Every dispatch by hand goes to the end and shows every pair: macOS loses runs to the runner (Safari's lost sessions and refused probes, `mem:follow-ups/macos-ci-instability`), and one such pair would otherwise cancel 21 others of a 1.5-2 h run.
7. **Per-OS settings (my call, 2026-11-03, to be revised from the first runs):**

   | caller | `runs-on` | `browsers` | `time-scale` | `timeout-minutes` | `plan-timeout-minutes` |
   |---|---|---|---|---|---|
   | `ci.yaml`, `matrix-ubuntu.yaml` | `ubuntu-latest` | default | default | default | default |
   | `matrix-windows.yaml` | `windows-latest` | default | `'4'` (as `tests-windows.yaml`) | 100 | 60 |
   | `matrix-macos-26.yaml` | `macos-26` | `chrome,firefox,safari` | `'2'` (as `tests-macos-26.yaml`) | 90 | 30 |
   | `matrix-macos-27.yaml` | `xcode-27` (GitHub has no `macos-27` label yet; as `tests-macos-27.yaml`) | `chrome,firefox,safari` | `'2'` | 90 | 30 |

   The planner bounds each cell at 900 s × `BSQ_TIME_SCALE` (60 min on Windows, 30 min on macOS) and runs a pair's cells in parallel, except Safari's, which it serialises. So a pair job lasts at most one cell bound on Windows (100 min leaves the setup and the report), and on macOS at most two Safari bounds in a row (60 min) beside the parallel Chrome/Firefox cells (90 min leaves the setup): a hang ends in the planner as a failure that uploads its report, not as a cancel with none (my call, 2026-11-03, after the builder check).
8. **The release runs and reuses the matrix through `ci.yaml` alone.** Its `prior` job looks for one run, `ci.yaml`'s push run on the tagged commit, which now holds the matrix; its `matrix` output, its separate `matrix` job and that job's place in the `needs` of `release` and `untag` go. `verify` (which calls `ci.yaml`) runs the matrix when the push's run is not reusable. Its comment ("ci.yaml covers what the cells cannot") is rewritten accordingly. `prior`'s 50-minute wait now covers a CI run that lasts as long as its longest job (the matrix's ~10 min beside the tests').
9. **Live progress works as is**: each pair's check run is named `progress · <calling workflow> · <pair> · test` (`CI` on a push, `Matrix (<OS>)` by hand), and `node scripts/ci-watch.ts <run-id>` follows a run.
10. **A first run per OS, recorded**: durations per pair, the slowest pairs, counts, failures, in `mem:measurements/ci-runners`; each failure that is not the runner's gets its own entry in `mem:follow-ups`. Timeouts are adjusted from these numbers.

## Non-goals

- **Making the OS matrices a release gate, or triggering them automatically.** Later, user's call.
- **Folding `tests-<os>.yaml` into the matrix, or the unit/standalone/conformance runs into `matrix.yaml`.** Later.
- **Fixing what the first runs find.** Each failure is its own later piece, as for `feat/safari-suite`.
- **Safari on Linux or Windows**, or any change to the planner, `test-matrix.ts` or the tests. If the first runs show the planner cannot do something these workflows need, that is a finding to bring back, not to patch around in YAML.

## Anti-goals — a failure even if the OS matrices run

- **Any change to what the Linux matrix runs on a push of `main` or under the release**: its plan, pairs, columns, bounds, `fail-fast`, or that a new push of `main` supersedes the previous run while a release's run is never cancelled by `main`. What changes is only where it shows (inside the `CI` run) and how the release finds it.
- **A push of `main` or a release starting a Windows or macOS matrix.**
- **A release that publishes without the Linux matrix having passed on its commit**, through the push's run or its own.
- **A hung run holding runners for the hosted maximum (6 h)**: every job has an explicit timeout.

## Constraints

- **Permissions:** `checks: write` (live progress) is granted by `matrix.yaml`'s `cells` job and by every caller: `ci.yaml`'s `matrix` job, the four dispatch callers, and the release's `verify` (already). A called workflow cannot exceed its caller.
- **Workflow files:** `shell: bash` on every `run:` step (Windows), as `tests.yaml` does; actionlint (`node scripts/actionlint.ts`) clean.
- **The report artifact** (`matrix-report-<job index>`, `.matrix/`, on failure) is unchanged; inside `ci.yaml` no other artifact takes that name (`tests.yaml`'s is `test-logs-<OS>`).
- **Concurrency of macOS jobs** is limited by GitHub per account (5 at a time on the free plan, unverified): the 22 pair jobs run in waves. Expected 1.5-2 h per macOS run, unmeasured.
- **No ruleset requires a check by name** (`mem:stack-and-build/ci`): the matrix's job names changing (`CI / matrix / cells (…)`, `Matrix (<OS>) / … / cells (…)`) breaks nothing.

## Left to the builder

- How the browser list becomes `--browser`/`--engine` arguments (the `IFS=, read -ra` loop of `tests.yaml` is the precedent).
- Comments in the workflows, in the style of `tests-<os>.yaml` and `ci.yaml` (why each OS's scale and timeouts).
- The proving runs: `CI` on a push (its `matrix` job green, 22/22 + plan, as before), `matrix-ubuntu.yaml`, and one run of each OS matrix, followed with `ci-watch.ts`. Pushing and dispatching wait for the user's go.

## Running the new workflows before the merge

`gh workflow run` answers 404 for a workflow file that exists only on a branch (`mem:lessons/process`), the four dispatch callers are new, and `ci.yaml` runs on a push of `main` or a pull request only. **The precedent of `ci/windows-macos` applies** (`mem:stack-and-build/ci`: "a temporary `push` trigger on the branch ran them before that"): while the branch is proved, the four callers and `ci.yaml` also carry `push: branches: [ci/matrix-os]`, in a commit of its own that is reverted before the merge, so `main` never receives it. A push of the branch then starts CI (with the matrix) and the four matrices; push only when a run is wanted.

## After the merge

- `mem:follow-ups/matrix-windows-macos` CLOSED (or left OPEN with what the first runs found, if they are red), `mem:stack-and-build/ci` updated (`matrix.yaml` reusable, `ci.yaml`'s `matrix` job, the four callers, the release's `prior` on `ci.yaml` alone), the first runs in `mem:measurements/ci-runners`.
