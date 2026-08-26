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
- The external assessment `docs/reviews/2026-08-17-0759-browser-sqlite.md` (9-agent review)
  is substantively correct but its **severity grading is not** — it marked all 9 axes
  BLOCKING, which discriminates nothing. Our triage is `mem:follow-ups`.

## Phase workflow (user, 2026-08-17)

Each wave or phase is implemented **on its own feature branch, by a subagent** — not on
`main`, not inline in the main session. A phase is closed only when all three hold:
**CI green** (types, format, lint), **memories updated**, **git clean**. Groundwork already
validated by the user outside a phase (dependency bumps, specs) lands on `main` directly.

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
- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one.
