# Git hooks

The local hooks, why they are not the gate, and what a green hook does not prove. Moved out of
`mem:follow-ups` on 2026-09-28 (user): the hooks are settled, and this is reference, not backlog.

## `post-checkout` — `node_modules` follows the branch (user, 2026-09-29)

`pnpm install` when a branch switch (`$3 = 1`) changes `package.json`, `pnpm-lock.yaml` or `patches/` between the two commits; nothing on a switch to the same commit. Without it a switch left `node_modules` with the previous branch's wa-sqlite patch, and a run on `main` measured the other branch (found after `test/retry-per-call-ops`). ~0.3 s per switch.

**A merge reinstalls in its own hooks, since 2026-10-05 (user).** `git merge` fires no `post-checkout`, and the `git switch main` before it installs `main`'s side; so `pre-merge-commit` (clean merge) and `pre-commit` (a conflicted merge concluded by `git commit`, detected by `MERGE_HEAD`) run `pnpm install` first when the index differs from `HEAD` on `package.json`, `pnpm-lock.yaml` or `patches/`. The merge's `tsc` and `pnpm test` then run on the install the merge brings, and `node_modules` matches the lockfile afterwards. **First real merge through it: 2026-10-05, `perf/jspi-sync-relays`** — `pre-merge-commit` installed the new patch (`Packages: +1 -1`) before `pnpm test`, green, and the installed wa-sqlite glue was the patched one. Checked before that with stubbed `pnpm` in a scratch repo: install on a clean and a conflicted merge touching those paths, none on a merge that does not, none on an ordinary commit. Before it, `node_modules` kept the previous pin under a lockfile naming the new one (2026-10-01, found with `readlink -f node_modules/wa-sqlite`). **Two flags, from the pre-merge review:** `--frozen-lockfile`, as CI runs it — a hand-resolved lockfile that does not match `package.json` fails the merge instead of being fixed in the working tree only and failing CI later; and `SKIP_INSTALL_SIMPLE_GIT_HOOKS=1`, because `prepare` rewrites `.git/hooks/<hook>` in place while sh is still reading it, and a longer new hook would run its tail inside the old one (the merged config takes effect at the next checkout or `pnpm install`). **Not covered:** a fast-forward (`git pull`), `git merge --squash`, and `git merge --abort` after a failed `pre-merge-commit` (it leaves the merged side installed) — run `pnpm install` by hand there. `post-checkout`'s own install still reinstalls the hooks, and is the last command of its hook.

**A branch that predates the hook uninstalls it.** `pnpm install` runs `prepare: simple-git-hooks`, which installs the ARRIVING branch's `simple-git-hooks` config and removes hooks absent from it — so the hook fires once into such a branch, then is gone, and the switch back does not reinstall. Measured on the first round trip. Fixed there by cherry-picking the hook commit (`e22d0f2` on `main`) onto the branch; do the same for any older branch before switching to it, or run `pnpm install` by hand after coming back. **A `git worktree add` on an older tag does the same** (2026-10-03): `post-checkout` runs `pnpm install` in the new tree, whose `prepare` reinstalls the SHARED `.git/hooks` from that tag's config — rc.5's dropped `post-checkout`. `pnpm exec simple-git-hooks` from the main checkout restores them; check `ls .git/hooks` after any worktree on an old ref.

## One script decides and runs (user, 2026-10-13; first version 2026-10-06)

Every hook command ends with `node scripts/hook-gate.ts <hook> --run` (after the conditional `pnpm install` of the merge paths). The script gathers the facts from git, decides with a pure, unit-tested `checksFor(hook, facts)`, prints the decision on one line, and runs the checks in a fixed order (`tsc`, `lint-staged`, `biome`, `actionlint`, `docs`, `unit`, `test`, `conformance`, `bench`, `consumer`), stopping at the first failure with its code. Without `--run` it prints the decision only — `node scripts/hook-gate.ts pre-push` by hand does not wait on a terminal's stdin and says "no refs on stdin" rather than "nothing to check" (git runs the hook only with refs to push); from a non-TTY empty stdin (an agent's shell) it falls back to the full list. If gathering the facts throws, the hook's full list runs. Design: `docs/superpowers/specs/2026-10-13-test-triggers-design.md` § 3.

**File classes, by exclusion:** workflows (`.github/workflows/*.yml|yaml`); ignored (the rest of `.github/`, `.serena/`, `docs/`, `.claude/`, any `.md` but `README.md`/`VFS.md`); generated docs (`README.md`, `VFS.md`); code (everything else, so a new kind of file is checked by default). A changed workflow adds `actionlint` on every hook; a change made only of workflows runs it alone.

**The rules:**
- `pre-commit`: code staged → `tsc`, `lint-staged`, `unit` (~2 s).
- `pre-merge-commit`, and `pre-commit` concluding a conflicted merge (`MERGE_HEAD`; it keeps `lint-staged` too): files = what the merge brings. Code → `tsc`, `biome`, `docs`, `pnpm test`; plus `conformance` when `src/`, `tests/conformance/`, `patches/` or `pnpm-lock.yaml` moved; plus the bench check (`pnpm bench:build`, `check.ts chrome --all` on port 8123) when `scripts/bench/` moved; generated docs alone → `docs`.
- `pre-push`: files of the commits no remote has yet. Code → `tsc`, `biome`, `docs`; plus `pnpm test` only when a pushed branch carries a **direct code commit** (`git log --first-parent --no-merges <sha> --not --remotes` touches code — commits that came in through a merge were tested by `pre-merge-commit`); plus `pnpm test:consumer` when a `refs/tags/v*` ref is pushed, even alone. A deleted ref counts for nothing.
- `delivery` (not a hook, the agent's command): the `pre-merge-commit` rules on the branch against `main`, committed, uncommitted and untracked.

The cases are unit-tested on throwaway repositories (`tests/unit/hook-gate.test.ts`): a direct commit vs a merged one, the release push (`main` and its tag in one stdin), a tag alone, a deleted ref, a new branch, a conflicted merge, delivery's three sources.

## The three commit/push hooks (user, 2026-09-11)

Decided and installed on 2026-09-11, in `package.json` under `simple-git-hooks`; what each runs is decided per change since 2026-10-13 (§ One script decides and runs). History of that first version: `pre-commit` ran `tsc`, `lint-staged` and the unit project; `pre-merge-commit` and `pre-push` ran `tsc`, `biome ci .` and `pnpm test`, `pre-push` adding the generated-docs check (2026-09-15, after a hand edit inside a generated span of `VFS.md` failed rc.5's first CI run; `README.md` since 2026-10-06). Until 2026-10-13 `pre-push` re-ran the suite on merges `pre-merge-commit` had already tested.

Verified in a scratch repository: an ordinary commit, a clean `--no-ff` merge, a conflicted
merge concluded by `git commit` and by `git merge --continue`, and a push each fire the
expected hook and only it.

**The user's principle: the agent runs the full verification when it delivers; the hooks are
braces on the belt, not the gate** (`mem:conventions`). The full suite cost ~80 s per commit —
chromium+unit 19 s, firefox 49 s, isolated 12.5 s, measured 2026-09-11 — against under 2 s for
`tsc`, biome and the unit project together.

What the change gives up, knowingly: a browser-only regression on a feature branch surfaces
at the merge, not at the commit that caused it; a flake is sampled once per merge rather than
once per commit; a direct commit on `main` can sit red locally until the next push. And every
hook still checks the working tree, not the staged tree.

What the entry established before the decision, kept for its evidence:

- **What it has caught.** A one-in-eighteen Firefox flake at a closure, after every task
  review had passed (`mem:lessons`, "A pre-merge verification is not ceremony"); and a
  Firefox-only flake that CI alone had shown as noise for weeks, once the per-engine split put
  Firefox in the hook (`mem:lessons`, "A test that waits for a TRANSIENT state").
- **What it does not guarantee.** On 2026-09-10 commit `c2ef918` landed with a failing
  `tsc`, although the hook ends with `tsc`. Traced on 2026-09-11 from the implementer's
  transcript:
  - **Nobody bypassed it.** No `--no-verify`, no `SKIP_SIMPLE_GIT_HOOKS` anywhere in the
    agent's commands. Its attempt at 15:11:52 was REFUSED by the hook's `tsc`.
  - **Its next attempt, started 15:13:40, was already a commit in `git log` at 15:14:05** —
    25 s in, when that hook's suite alone takes ~100 s; the captured output stops at the start
    of the suite. The hook cannot have reached `tsc`.
  - **Hypothesis, not proven:** the agent's tool cut or backgrounded the command mid-hook,
    and the hook exited without failing. To test it cold, in a throwaway clone and never in this
    repository's `.git`: a pre-commit hook of `sleep 5; echo x; sleep 60; exit 1`, `git commit` under a
    wrapper that closes the command's stdout or sends it SIGTERM/SIGHUP after 3 s, and see whether
    the commit lands; then the same through the harness's own background mechanism. If it holds, "the hook passed" is not evidence whenever the committer's shell can
    drop a long command.
  - Separately, the hook runs `tsc` against the WORKING TREE, not the tree being committed,
    and honours `SKIP_SIMPLE_GIT_HOOKS=1` and `$SIMPLE_GIT_HOOKS_RC` — two more ways a green
    hook can differ from a green commit. Only a per-commit check in a clean worktree proved the
    rest of that branch.
- **The hook file is rewritten by design, and that is harmless.** `"prepare":
  "simple-git-hooks"` reinstalls `.git/hooks/pre-commit` — same content — on every
  `pnpm install` and every `pnpm pack`, so `pnpm test:consumer` rewrites it (its first stage
  packs). A changed mtime on that file is not evidence of tampering: on 2026-09-10 at 15:02:52
  it was a subagent's unasked `pnpm store prune && pnpm install`; on 2026-09-11 it was the
  consumer smoke.
- **Merging a branch that changes the pin or the patch tested the OLD install until 2026-10-05** (seen 2026-10-03, the 7fcc30d repin: the merged tree ran against main's wa-sqlite, went red once, not reproduced, cause not proven). The merge hooks now install first (§ `post-checkout` above). After such a merge, `readlink -f node_modules/wa-sqlite` naming the new pin is still the one-line check.
