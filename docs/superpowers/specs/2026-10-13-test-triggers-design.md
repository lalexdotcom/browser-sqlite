# Test triggers — what runs, where, and when

Date: 2026-10-13. Status: design approved in conversation, awaiting review of this document.

## 1. Why

The list of what runs when was written before the test planner and before `matrix.yaml` ran on every push of `main`. Since then:

- `pnpm test` (complement mode) runs every browser test at least once per browser, so the matrix no longer adds test coverage — it adds pair diversity. The convention still says "`pnpm test` covers two pairs, the matrix is the only thing that sees the other twenty".
- A release pushes `main` and its tag together, so the same commit runs `ci.yaml` and `matrix.yaml` twice: once for the push of `main`, once called by `release-and-publish.yaml`.
- `pre-push` re-runs `pnpm test` on merges `pre-merge-commit` already ran it on.
- Conformance runs nowhere locally; the generated-docs check is missing from the merge; the consumer smoke runs on every PR and push of `main` although it only proves the package is usable once published; the bench check runs nowhere.
- Nothing checks a workflow before GitHub runs it, and nothing checks the package's metadata statically (exports, types resolution) — the consumer smoke drives bundlers, it compiles no TypeScript against the published types.

## 2. The target — test → where

"Hook" means git runs it; "convention" means the agent runs it because a memory says so.

| Test | Local | CI |
|---|---|---|
| `tsc --noEmit` | hook: commit, merge, push · convention: delivery | `verify` (PR, push of `main`, release when not reused) |
| biome | hook: commit (`lint-staged`), merge and push (`biome ci`) · convention: `pnpm check` after each change | `verify` |
| actionlint (with shellcheck) | hook: commit, merge, push, when a workflow changes | `verify` |
| `docs:vfs` + `git diff --exit-code VFS.md README.md` | hook: merge, push · convention: delivery | `verify` |
| `pnpm build` | implicit in every browser run (`globalSetup`) | `verify` |
| `test:unit` | hook: commit | inside `pnpm test` |
| `pnpm test` | hook: merge; push only when it carries a code commit made directly on its branch (§ 3.3) · convention: delivery | `verify` |
| `test:conformance` | hook: merge, when the merge touches the VFS surface (§ 3.2) · convention: delivery, same condition | `verify` |
| matrix (all pairs) | convention: a branch touching the per-connection machinery or the wa-sqlite pin/patch → `gh workflow run matrix.yaml --ref <branch>` on the pushed branch (push asked of the user), remote branch deleted afterwards; `pnpm test:matrix` stays available by hand | push of `main`; release when not reused (§ 5.3) |
| consumer smoke, publint and attw included (§ 5.5) | hook: push of a `v*` tag | release only |
| bench check | hook: merge, when the merge touches `scripts/bench/` | `pages.yaml`: the half of the site that run builds anew (§ 5.4) |

The matrix is the one convention no hook doubles. Delivery doubles the merge hook on purpose: it is the agent's verification before reporting, and it comes before the merge.

## 3. Local hooks

### 3.1 One script decides and runs

`scripts/hook-gate.ts` today classifies files and answers with an exit code (0 full, 10 docs, 11 nothing); the hook's shell then runs a fixed list. The new rules need more than three answers, so the script both decides and runs:

- A pure, unit-tested function maps a hook and its **facts** to an ordered list of checks. Facts: the changed files, and for `pre-push` the code commits made directly on a pushed branch and whether a `v*` tag is pushed. Checks, in this fixed order: `tsc`, `lint-staged`, `biome`, `actionlint`, `docs`, `unit`, `test`, `conformance`, `bench`, `consumer`.
- `node scripts/hook-gate.ts <hook> --run` gathers the facts from git, prints the decision on one line, and runs the checks one after another with inherited stdio, stopping at the first failure with its exit code.
- If gathering the facts or deciding throws, it runs the hook's full list and says so. A new kind of file is still code by default (classification by exclusion, unchanged).
- The conditional `pnpm install --frozen-lockfile` of the merge paths stays in the `package.json` hook command, before the script, as today.

### 3.2 Rules

File classes: workflows (`.github/workflows/*.yml`, `*.yaml`) — new; ignored (the rest of `.github/`, `.serena/`, `docs/`, `.claude/`, any `.md` but the generated two); generated docs (`README.md`, `VFS.md`); code (everything else). In every hook below, a changed workflow adds `actionlint`, and a change made only of workflows runs `actionlint` alone.

- **`pre-commit`** (ordinary commit): code staged → `tsc`, `lint-staged`, `unit`. Otherwise nothing.
- **`pre-merge-commit`**, and **`pre-commit` concluding a conflicted merge** (`MERGE_HEAD` exists; that path also keeps `lint-staged`): files = what the merge brings (index against `HEAD`).
  - code → `tsc`, `biome`, `docs`, `test`;
  - plus `conformance` when a file is under `src/`, `tests/conformance/` or `patches/`, or is `pnpm-lock.yaml` (the wa-sqlite pin lives there);
  - plus `bench` when a file is under `scripts/bench/`;
  - generated docs only → `docs` (today: nothing);
  - otherwise nothing.
- **`pre-push`**: files = those of the commits no remote has yet (unchanged).
  - code → `tsc`, `biome`, `docs`; generated docs only → `docs`;
  - plus `test` when a pushed branch carries a **direct code commit**: `git log --first-parent --no-merges <sha> --not --remotes` lists a commit touching code. Commits that reached the branch through a merge are excluded — `pre-merge-commit` ran the suite on them. A commit made directly on `main`, or the commits of a feature branch pushed for a matrix run, count;
  - plus `consumer` when a ref `refs/tags/v*` is pushed, whatever the commits (a tag pushed alone, on a commit already on the remote, still runs it).

`actionlint` is `node scripts/actionlint.ts` (§ 3.4); `conformance` is `pnpm test:conformance`; `bench` is `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.ts chrome --all`; `consumer` is `pnpm test:consumer`.

### 3.3 Delivery as a command

`node scripts/hook-gate.ts delivery --run` applies the `pre-merge-commit` rules to the branch against `main` (`git diff --name-only main...HEAD`, plus uncommitted changes), so the delivery convention is one command rather than a rule to apply by hand.

### 3.4 actionlint

`scripts/actionlint.ts` holds the pinned actionlint version and the SHA-256 of each platform's release archive, on the model of `scripts/browsers.ts`: `install` downloads and verifies the archive into `node_modules/.cache/actionlint`, and a call with no argument runs the binary on `.github/workflows/` (installing first if missing). `.devcontainer/post-create.sh` runs `install`. actionlint runs shellcheck on every `run:` block when `shellcheck` is on the `PATH`: `post-create.sh` installs it with apt, and CI checks the runner image has it (installs it otherwise). A missing shellcheck is an error in `scripts/actionlint.ts`, not a silent downgrade.

What exists today is fixed first: every finding on the current workflows is corrected, or disabled at its line with the reason when it is wrong for us. That cleanup is its own step of the plan, before anything else touches a workflow, so the workflow changes of § 5 are linted as they are written.

## 4. Conventions

- **Delivery**: `node scripts/hook-gate.ts delivery --run` (§ 3.3), its report read — `Test Files` line included.
- **Matrix on a branch**: when a branch touches `src/pool.ts`, `src/transaction.ts`, `src/worker/`, the wa-sqlite pin or `patches/`, `VFS_CAPABILITIES`, the target machinery or the need vocabulary — the user is asked to push the branch, then `gh workflow run matrix.yaml --ref <branch>`, its verdict read, and the remote branch deleted. "A new browser test with no need" leaves the list: the planner places it. Otherwise the matrix verdict comes from the push of `main`.
- **Release**: pushing `main` and the tag in one command, or in two, are equivalent (§ 5.3); the "one command" rule goes.

## 5. CI

### 5.1 `ci.yaml`

The `consumer-smoke` job leaves it. `verify` gains one step, `node scripts/actionlint.ts`, before `tsc`. Triggers unchanged (push of `main`, PR, `workflow_call`).

### 5.2 `matrix.yaml`

Unchanged: `workflow_call`, `workflow_dispatch`, push of `main`.

### 5.3 `release-and-publish.yaml` — reuse the runs of the push of `main`

Triggered by the tag, as today. A first job, `prior`, resolves the tag's commit (`git rev-parse "$GITHUB_REF^{commit}"`) and, for `ci.yaml` and `matrix.yaml` in turn, finds the latest run on that commit with event `push` (`gh run list --workflow <file> --commit <sha> --event push --limit 1`). If one exists it waits for it (`gh run watch <id> --exit-status`). Its output for each workflow is `success` or `rerun`: anything but a successful run — none, cancelled (a later push of `main` supersedes it), failed — is `rerun`, and the release's own run of that workflow decides. `prior` needs `actions: read` and is bounded (60 min).

- `verify` (calls `ci.yaml`) runs only if `prior` says `rerun` for CI; `matrix` (calls `matrix.yaml`) likewise.
- `consumer-smoke` (moved from `ci.yaml`) always runs.
- `release` needs `prior`, `verify`, `matrix`, `consumer-smoke`, with `if: ${{ !cancelled() && !failure() }}` so a skipped (reused) check does not skip it.
- `untag` needs the same four, `if: failure()`, unchanged otherwise.
- `pages` needs `release`, unchanged.

The cases: `main` and tag in one push → the runs exist and are in progress, `prior` waits; tag pushed later → the runs are done, `prior` reads them at once; tag on a commit whose runs were cancelled → the release runs its own. The ref stays the tag: the release action, the notes step, `untag`, npm's OIDC and Pages see what they see today.

### 5.4 `pages.yaml` — the bench check

The root and `/preview/` are each built from their own tag (page HTML and `dist/` included), so each run checks the half it builds anew:

- called by a release (`github.ref` is `refs/tags/v*`) → the root, `_site`;
- push of `preview` → `_site/preview`;
- `delete` → nothing (the root is the release already checked).

The step runs after both halves are assembled and before `upload-pages-artifact`, from the workspace checkout: `pnpm install --frozen-lockfile` at the root, the browser cache, the AppArmor `sysctl` and `node scripts/browsers.ts install`, as in every job that drives a browser. A red check stops the deployment, not the npm publication (Pages runs after `release`).

`scripts/bench/check.ts` takes the directory to serve (`--dir <path>`, default `_site`), and its header loses "not wired into CI and must not be".

### 5.5 publint and Are the Types Wrong? in the consumer smoke

Two stages added to `scripts/consumer-smoke.ts`, right after the pack that opens it, both on that same tarball: **publint** (the `package.json` against the tarball's content — `exports`, `main`, `types`, `files`, condition order) and **`@arethetypeswrong/cli`** (the published types under each TypeScript resolution mode). Both are pinned devDependencies. The package is ESM only, so attw's CommonJS `require` findings are expected: the profile or rule set that ignores them is taken from the installed version's own options, never a blanket ignore. A finding fails the stage, as any other stage. They run where the smoke runs: the push of a `v*` tag, and the release's `consumer-smoke` job.

## 6. Memories

`conventions` (§ When to run the full matrix, rewritten as § 2 and § 4; delivery; release push), `git-hooks` (the three hooks and the gate), `stack-and-build` (CI and hooks; the benchmark page; "six invariants" → seven), `state` (the delivery line, the baseline's consumer row: its stage count changes).

## 7. Verification

- The decision function: unit tests for every rule of § 3.2, including a direct commit vs a merged one, a tag pushed alone, docs-only merges, and the conformance and bench paths.
- The fact gathering and `--run`: a scratch repository with stand-in checks (as on 2026-09-11 and 2026-10-06) — a commit, a clean merge, a conflicted merge concluded by `git commit`, a push of a merge, of a direct commit, of a tag alone; each runs exactly its checks, and a failing check fails the hook.
- `prior`'s lookup and wait: run by hand with `gh` against existing runs (the last push of `main`: two successful runs) and against a commit with none.
- actionlint: clean on the current workflows after the cleanup step; a deliberate fault (a `needs.<job>.outputs` naming a missing output, a shell error in a `run:`) makes it fail, locally and in `verify`.
- publint and attw: green on the current package; a deliberate fault (a `types` condition after `import`, a `files` entry dropping a `.d.ts`) fails each.
- `check.ts --dir`: run locally on `_site` and on a copy under `_site/preview`.
- The workflow wiring (`if` conditions, needs) has no local check: proven on GitHub by the next release, and the bench step by the next push of `preview` — both outward, each asked for when it comes.

## 8. Out of scope

`pages.yaml`'s shared `cancel-in-progress` group; the release action's non-idempotence; the bench page breaking from a `src/` change (seen at the next Pages deployment, after publication — accepted).
