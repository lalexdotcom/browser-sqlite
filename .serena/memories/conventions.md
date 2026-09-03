# Working conventions

`AGENTS.md` is authoritative and is read automatically — user leads, one step at a time,
French in chat and English everywhere else, no unsolicited action on a question, Serena
symbolic tools primary for code, `pnpm check` after every modification. **This file holds
only what `AGENTS.md` does not say.**

## Where things live

- These memories live in `.serena/memories/`, which is **not** gitignored — commit them.
- Specs and plans: `docs/superpowers/specs/` and `docs/superpowers/plans/`. Read the spec,
  not a summary of it, when picking up designed-but-unbuilt work.
- The agent framework is **superpowers**. A `.planning/` directory from a previous
  framework was deleted on 2026-08-17 — do not recreate it or trust anything quoting it.
- **Probes and fixtures go in `.scratchpad/` (user, 2026-08-31)**, gitignored, at the
  repository root rather than in the session's own temp directory — the user wants to
  open them. Nothing in `src/`, `tests/` or CI may depend on anything there. `.work/` is
  the neighbouring convention, for scratch clones of upstream repositories.
- The external assessment `docs/reviews/2026-08-17-0759-browser-sqlite.md` (9-agent review)
  is substantively correct but its **severity grading is not** — it marked all 9 axes
  BLOCKING, which discriminates nothing. Our triage is `mem:follow-ups`.

## Phase workflow (user, 2026-08-17)

Each wave or phase is implemented **on its own feature branch, by a subagent** — not on
`main`, not inline in the main session.

**A branch is for a feature going through the superpowers workflow, and for nothing else
(user, 2026-08-27).** Editing the README, fixing a test's calibration, adding a config
switch — that is inline work and it stays on the branch already in hand, `main` included.
Two branches were opened in one afternoon for a Known Limitations line and a browser
selector; they then diverged on the same memory file and had to be collapsed. The earlier
note about specs travelling with their branch still holds — it is about the branch a
*feature* already has, not a reason to open one. A phase is closed only when all three hold:
**CI green** (types, format, lint), **memories updated**, **git clean**. Groundwork already
validated by the user outside a phase (dependency bumps) lands on `main` directly.

**Specs and plans go on the branch, not on `main` (user, 2026-08-27).** This file said the
opposite and it was wrong: a spec is the first artefact of the work it designs, so it
travels with that work and lands at the merge. Two spec commits went straight to `main`
before the correction and were left there rather than rewritten, so the history carries
the exception once.

**A plan's per-task commits do not survive this repository's pre-commit hook.** The hook
runs the whole suite and refuses a red tree, so a plan written as "task N: write the
failing test / commit" cannot be executed as written — the commit after a RED step is
refused. Write plans whose every commit lands on green: the failing test and the code that
satisfies it belong to the same task, and a task that only adds tests must be one whose
tests pass on arrival. `feat/bulk-backpressure`'s five tasks collapsed into two commits
for this reason, which is a property of the repository, not of that plan.

## `.superpowers/` artefacts are not a subject (user, 2026-09-03)

**Do not log SDD scratch — ledgers, briefs, task and fix reports — as a backlog item, and do
not raise it as a finding.** It is non-versioned working material; if a stray one was
force-added past the ignore rule and is now tracked, that is not worth an entry either. The
follow-up that tracked two such files on `main` was deleted on this instruction.

The corollary: do not spend a session's attention proving how one got past `.gitignore`.
Leave the files, leave the workspaces, say nothing.

## "On clôture la session" is a defined procedure (user, 2026-08-17)

Not a figure of speech. It means the work continues in a *different* session, so nothing
may be left live in this one. Three steps, in order:

1. **Merge the feature branch into `main`** — the phase's closure conditions must hold
   first.
2. **Write the memories.** Anything the next session needs and cannot re-derive from the
   code: decisions and their rationale, traps paid for, open items with their evidence.
   Whatever lives only in a scratch ledger or in the conversation is lost.
3. **Commit whatever is still outstanding.** Obvious leftovers go in directly; for anything
   that is not obvious, ask first.
4. **Delete every branch that is no longer needed, local and remote** (user, 2026-08-27).
   A ref whose commits are all in `main` is noise: the next session cannot tell it apart
   from work in progress and will ask.

   **`superpowers:finishing-a-development-branch` covers this only partly — do not stop
   where it stops.** Its merge option ends with `git branch -d <branch>`, and that command
   compares against the branch's *upstream*, not against `main`: a branch that was ever
   pushed is refused even when it is fully merged, which is exactly how ours survived its
   own merge. The skill also never touches the remote ref — its push option deliberately
   keeps the branch for PR iteration, so nothing cleans `origin/feat/*` after a local
   merge. And it is scoped to the branch in hand, so refs left by earlier waves are
   nobody's job.

   So: prove containment with `git merge-base --is-ancestor <branch> main`, then
   `git branch -D` locally and `git push origin --delete` for the remote, and sweep every
   ref rather than only the current one. Four stale local branches and two merged remote
   ones came out of one such sweep.

## Git and versioning

- **Everything lands in the unreleased version until the user says otherwise (user,
  2026-08-26).** There is no "too late for this release" — work goes into the current
  unreleased section of `CHANGELOG.md`, and the user says **explicitly** when they want the
  version bumped. Do not propose freezing a release, and do not scope work by proximity to
  one.
- **Pushing is not part of committing (user, 2026-08-24).** `main` may sit ahead of
  `origin/main` for as long as the user wants; do not recommend pushing as housekeeping.
  Push only when asked, or when the point is to trigger CI and the user has said so.
- **Unplanned working-tree changes are committed, not discarded — but only after the user
  confirms.** Never resolve a dirty tree by reverting or stashing on your own initiative.

## Releasing (user, 2026-08-31)

**No automation writes to `CHANGELOG.md`.** The workflow reads it; the action
receives a file path and never learns where it came from. Dating a heading,
opening a new `## Unreleased`, and consolidating the rc sections into a final
`## 1.0.0 — <date>` are all instructed acts, never scripted ones.

**The bump is one commit, then a tag.** `package.json` and the dated CHANGELOG
heading must be true of the same tree, because the release workflow refuses a
tag that disagrees with either. `upversion` is **not** used for this package —
it was, and the tag/`package.json` coupling it provided is now enforced in the
workflow instead.

**The two repositories cannot be updated together.**
`lalexdotcom/action-release-and-publish` releases itself on push to `main` from
conventional commits, and we consume it by SHA, so its change must be pushed and
released before the pin in `release-and-publish.yaml` can be repointed. The
clone lives at `.work/action-release-and-publish`.

**The GitHub Release is created before `npm publish`**, inside the action. That
ordering is the whole reason a failed release costs a retag rather than a burnt
version number; do not reorder it back.

**Do not add `set -e` to the extraction step.** Two reviews have proposed it and it
was refused both times: under `pipefail` it would abort
`PKG=$(grep '"version"' package.json | …)` silently when the grep finds nothing,
replacing a diagnosable `tag vX != package.json ()` with no message at all. The
only path it would newly protect — a missing `CHANGELOG.md` — is already caught
by the emptiness test. That test is `grep -q '[^[:space:]]'` and **not `[ -s ]`**,
because a section holding one blank line is one byte long and `-s` calls it
non-empty; this was found by running the block against a fixture, not by reading it.

Design: `docs/superpowers/specs/2026-08-31-release-notes-from-changelog-design.md`.

## Writing for the consumer

- **The README is for the consumer.** State the constraint and what it costs them; the
  mechanism, the evidence and the investigation go to code comments, these memories, or a
  PR description. A fifteen-line Known Limitations entry about a WebKit bug was cut to one
  sentence plus `26+` in the generated table.
- **Do not explain compatibility in prose.** Version numbers in the tables are enough. A
  Requirements subsection arguing *why* each API mattered was cut for exactly this reason.
- **The README is edited iteratively — do not commit each pass.** Several round trips are
  normal; committing after every one forces the user to brake. Make the edit, show what
  changed, wait.

## Working with the user

- **Batch diagnostic probes.** When the user has to run probes by hand, send a whole
  battery in one paste, each written for the case where the previous came back clean. Four
  round trips were burned on one-hypothesis-at-a-time before they called it.
- **Always give a verdict when offering options.** A menu without a recommendation is not
  an answer.
- **That rule runs one way only (user, 2026-08-27).** When *you* offer options, decide and
  recommend. When the *user* offers two without stating a preference — "soit A, soit B" —
  that is a question to answer, not a mandate to pick one and act. In one session an option
  was chosen and committed on the user's behalf minutes after they had said explicitly not
  to commit until the name suited them.
- **A choice a skill asks you to offer belongs to the user (user, 2026-08-27).**
  `writing-plans` ends by offering subagent-driven or inline execution. That offer was
  resolved unilaterally, by treating "I may not dispatch subagents unless asked" as the
  answer — when it was precisely the reason to ask. At every point where a skill offers a
  choice, put it to the user, including when one option looks closed.
- **Never substitute your own design for a decision the user has already made (user,
  2026-08-28).** Propose the alternative and confront them with it; if they hold, implement
  theirs. They judge a delivery against what they decided, so a silent substitution makes
  them re-audit work they thought was settled — and the drift surfaces late, or never.
  The retry round's decision point had been specified as "une fois le allSettled terminé".
  It was replaced by "remove the `everReady` condition in the supervisor's R1", which cannot
  work: `liveCount()` counts a slot as alive from `report('spawned')`, so during startup the
  predicate is true before anything has opened. Two turns went into rediscovering the user's
  own formulation and handing it back to them as a correction. **When an instruction names a
  *when*, a *where* or a *what*, check that choice against the code before proposing another
  one.**

- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one.
