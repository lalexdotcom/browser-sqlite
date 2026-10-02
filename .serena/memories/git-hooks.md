# Git hooks

The local hooks, why they are not the gate, and what a green hook does not prove. Moved out of
`mem:follow-ups` on 2026-09-28 (user): the hooks are settled, and this is reference, not backlog.

## `post-checkout` — `node_modules` follows the branch (user, 2026-09-29)

`pnpm install` when a branch switch (`$3 = 1`) changes `package.json`, `pnpm-lock.yaml` or `patches/` between the two commits; nothing on a switch to the same commit. Without it a switch left `node_modules` with the previous branch's wa-sqlite patch, and a run on `main` measured the other branch (found after `test/retry-per-call-ops`). ~0.3 s per switch.

**A merge does not reinstall, and the switch before it reinstalls the old side (2026-10-01).** Concluding a branch that changes the patch runs `git switch main` — which installs `main`'s patch, the one before the merge — then `git merge`, which fires no `post-checkout`. `node_modules` then holds the previous pin under a lockfile naming the new one; found the next day with `readlink -f node_modules/wa-sqlite`. Run `pnpm install` after any merge that touches `package.json`, `pnpm-lock.yaml` or `patches/`.

**A branch that predates the hook uninstalls it.** `pnpm install` runs `prepare: simple-git-hooks`, which installs the ARRIVING branch's `simple-git-hooks` config and removes hooks absent from it — so the hook fires once into such a branch, then is gone, and the switch back does not reinstall. Measured on the first round trip. Fixed there by cherry-picking the hook commit (`e22d0f2` on `main`) onto the branch; do the same for any older branch before switching to it, or run `pnpm install` by hand after coming back.

## The three commit/push hooks (user, 2026-09-11)

Decided and installed on 2026-09-11, in `package.json` under `simple-git-hooks`:

- `pre-commit` — `tsc`, then `lint-staged`, then the unit project: ~1.5 s. **While concluding a
  merge that stopped on a conflict** (`MERGE_HEAD` exists) it runs `pnpm test` instead of the
  unit project, because the commit that concludes such a merge fires `pre-commit` and never
  `pre-merge-commit`.
- `pre-merge-commit` — `tsc`, `biome ci .`, `pnpm test`. Every merge here is `--no-ff`, so
  every merge into `main` pays the full suite.
- `pre-push` — the same, as the backstop for commits made directly on `main` before anything
  reaches CI. Since 2026-09-15 it also runs CI's VFS table check, `pnpm docs:vfs && git diff
  --exit-code VFS.md` (user), after a hand edit inside a generated span of `VFS.md` failed the
  first CI run of rc.5 before it reached a single test.

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
