# Working conventions

`AGENTS.md` is authoritative and is read automatically — user leads, one step at a time,
French in chat and English everywhere else, no unsolicited action on a question, Serena
symbolic tools primary for code, `pnpm check` after every modification. **This file holds
only what `AGENTS.md` does not say.**

## Where things live

- These memories live in `.serena/memories/`, which is **not** gitignored — commit them.
  **Serena owns them: `read_memory`, `write_memory`, `edit_memory`.** They are `.md`, so
  `AGENTS.md` would allow Read/Edit — but a dedicated tool exists and hand-editing them with
  a shell one-liner is drift, caught by the user on 2026-09-08. The same holds for the three
  consumer pages: `replace_content` fails loudly on no match and on an ambiguous one, which
  is the only thing a scripted `assert` was buying.
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

**`AGENTS.md` states the git rules since 2026-09-30 and overrides what follows where they differ:**
every piece of work on its own branch off `main`, never a commit on `main` directly; a small
self-contained request may go inline on the branch in progress; Conventional Commits, a breaking
change with `!` and a `BREAKING CHANGE:` footer; never push unasked.

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

**A job with several steps always gets a feature branch (user, 2026-09-25).** This narrows the
rule above: the inline exception covers a single isolated edit, not a job made of several steps,
even when each step is only a test calibration. Said after two follow-ups (a test rewrite and a
re-measured bound, two commits) landed straight on `main` under the "calibration is inline"
reading. Those commits were left there.

**Specs and plans go on the branch, not on `main` (user, 2026-08-27).** This file said the
opposite and it was wrong: a spec is the first artefact of the work it designs, so it
travels with that work and lands at the merge. Two spec commits went straight to `main`
before the correction and were left there rather than rewritten, so the history carries
the exception once.

**Every commit of a plan lands on green — a rule of the work, no longer only of the hook.**
Until 2026-09-11 the pre-commit hook ran the whole suite and refused a red tree, so a plan
written as "task N: write the failing test / commit" could not be executed as written;
`feat/bulk-backpressure`'s five tasks collapsed into two commits for that reason. Since then
`pre-commit` runs only `tsc`, lint and the unit project, so a red BROWSER test no longer stops
a commit — it stops the merge, where `pre-merge-commit` runs `pnpm test`. The rule stands
anyway: a red commit breaks bisection, and the branch cannot merge while it is red. The
failing test and the code that satisfies it belong to the same task.

**The full verification at delivery is the agent's job, not the hooks' (user, 2026-09-11).**
Before reporting a task, a branch or a session as done: `pnpm test` AND
`pnpm exec tsc --noEmit`, all three reports read. The hooks are braces on the belt; a green
commit proves the unit project and nothing more.

## What every implementer prompt forbids (2026-09-11)

Beyond the Serena rule `AGENTS.md` already requires, every dispatch that may commit says, in
these words or stronger: **never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch
`.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`; run
`pnpm exec tsc --noEmit` yourself before each commit; if the hook fails, stop and report its
output verbatim; after committing, confirm with `git log` and `git show --stat HEAD`.** Two
reasons, both paid for on 2026-09-10: a subagent ran `pnpm store prune && pnpm install`
unasked — the prune reaches the machine's global store, outside the repository — and a commit
landed with a failing `tsc` from a subagent whose command was cut mid-hook
(`mem:git-hooks`). And **do not accept a subagent's "pre-existing"**
without checking the base commit.

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
- **The hooks are documented in `mem:git-hooks`**: what each one runs, why they are braces on
  the belt rather than the gate, and what a green hook does not prove.

## Releasing (user, 2026-08-31)

**No automation writes to `CHANGELOG.md`.** The workflow reads it; the action
receives a file path and never learns where it came from. Dating a heading,
opening a new `## [Unreleased]`, and consolidating the rc sections into a final
`## [1.0.0] - <date>` are all instructed acts, never scripted ones — done through
the `changelog-maintenance` skill (`AGENTS.md`).

**`CHANGELOG.md` follows Keep a Changelog since 2026-09-30 (user).** Headings are
`## [<version>] - <date>`, each with a link definition at the end of the file
(`compare/v<previous>...v<version>`, `[Unreleased]` against `HEAD`). Only the
format's own types are used. **A breaking change goes under `Changed` or `Removed`,
prefixed `**Breaking:**` and listed first** — there is no `Breaking` section;
performance and documentation changes go under `Changed` (user, same day). **The
sections published before that date keep their own subsections and text** — only
their headings changed; the consolidation into `1.0.0` rewrites them. The release
workflow finds a section by the prefix `## [<version>] - `, refuses an undated
heading or a missing link definition, and stops the body at the next heading or at
the link definitions.

**The bump is one commit, then a tag.** `package.json` and the dated CHANGELOG
heading must be true of the same tree, because the release workflow refuses a
tag that disagrees with either. `upversion` is **not** used for this package —
it was, and the tag/`package.json` coupling it provided is now enforced in the
workflow instead.

**The two repositories cannot be updated together.**
`lalexdotcom/action-release-and-publish` releases itself on push to `main` from
conventional commits, and we consume it by its major tag (`@v3`, user, 2026-10-03: the action is ours and follows semver), so a minor or patch reaches the next release once it is pushed and released, with no commit here; a major needs the tag in `release-and-publish.yaml` moved. The clone lives at `.work/action-release-and-publish`. **Since v3 the action manages the dist-tags itself**: `latest` only moves forward, `next` stays on the highest rc above it, and a `latest` that moves removes the tags left on older prereleases. So the 1.0.0 release publishes straight to `latest`, creates no `stable` tag, and removes `rc` and `next` — `npm i browser-sqlite@rc` stops resolving instead of installing an old rc.

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

**Since 2026-09-07 the consumer documentation is three files** — `README.md`, `API.md` and
`VFS.md` (`mem:state`). Both rules below were written about the README and apply to all
three.

- **The README is for the consumer.** State the constraint and what it costs them; the
  mechanism, the evidence and the investigation go to code comments, these memories, or a
  PR description. A fifteen-line Known Limitations entry about a WebKit bug was cut to one
  sentence plus `26+` in the generated table.
- **No counts in docs or comments outside measurements (user, 2026-09-24).** "The VFS above", "the following VFS", "the VFS that now default to `jspi`" — never "the five VFS above" or "the other four". A number is written only when it is a measurement or a real value (a length limit, a version). A count goes stale when a VFS is added and made a broken reference look precise. Released CHANGELOG sections are history and stay as written.
- **`CHANGELOG.md` lists what changes — no detailed description (user, 2026-10-02).** No commit SHA, no measured figures, no internal mechanism in an entry: what changed for the consumer, in a sentence or two. Migrations are documented in `API.md`/`README.md`/`VFS.md` only between stable versions; until 1.0 ships, a migration that must be written down stays in the CHANGELOG entry.
- **Do not explain compatibility in prose.** Version numbers in the tables are enough. A
  Requirements subsection arguing *why* each API mattered was cut for exactly this reason.
- **Consumer documentation is edited iteratively — do not commit each pass.** Several round
  trips are normal; committing after every one forces the user to brake. Make the edit, show
  what changed, wait.

## The harness cannot honour half of the model policy (2026-09-09)

`AGENTS.md` says never to dispatch a subagent without an explicit `model` **and** to always pass
`effort` too. **The `Agent` tool in this harness exposes no `effort` parameter** — only
`model`, `subagent_type`, `prompt`, `isolation` and `run_in_background`. So the pairing is
honoured on the model half alone, and a subagent inherits the session's effort level whatever
tier it was dispatched at. Recorded rather than worked around; if `effort` appears later, the
policy becomes applicable as written.

## When to run the full matrix (2026-09-22)

`pnpm test:matrix` costs ~45 min and covers the 22 declared (vfs, build) pairs × 3 engine configs.
`pnpm test` covers **two recommended pairs**, so the matrix is the only thing that sees the other
twenty. Run it when the change can behave differently per pair:

- **the per-connection machinery** — `src/pool.ts`, `src/transaction.ts`, `src/worker/`;
- **a wa-sqlite repin or a change to `patches/`** — every VFS comes from there;
- **`VFS_CAPABILITIES`, the target machinery or a `needs` vocabulary change** — they decide which
  pairs run what;
- **a new browser test with no `needs`**, since it will run on all 22 pairs whether or not you
  thought about them;
- **before a release**.

Not for documentation, memories, or a test change confined to what `pnpm test` already covers.

**Two things about reading a red cell, both paid for on 2026-09-22.** A timing-sensitive failure
may be LOAD rather than a defect: re-run the cell alone before diagnosing — `tx-savepoint`'s T4 went
0/3 alone against 2/4 in the full cell. And the cause may be a test you just added: a matrix cell is
one browser running one project's files (`mem:lessons`). `scripts/matrix-triage.ts` regroups any
`.matrix/<run>/`.

## Working with the user

- **Batch diagnostic probes.** When the user has to run probes by hand, send a whole
  battery in one paste, each written for the case where the previous came back clean. Four
  round trips were burned on one-hypothesis-at-a-time before they called it.
- **For Safari, serve the bench from the container (user, 2026-09-14).** `node
  scripts/static-server.ts _site 8099` (after `pnpm bench:build` if the page changed) and the user
  opens `http://localhost:8099/`: VS Code forwards the port to their Mac, localhost is a secure
  context, and the origin is apart from `lalexdotcom.github.io`, whose tabs can block IndexedDB.
  Moving `preview` costs a pre-push `pnpm test` and a Pages deploy per iteration; do it only for a
  device that cannot reach the container, or when asked. Playwright's Linux WebKit is no stand-in
  for Safari — it lacks `FileSystemSyncAccessHandle` and loads no worker at all.
- **Always give a verdict when offering options.** A menu without a recommendation is not
  an answer.
- **A fact known to be false, whose true value you hold, is corrected — not reported (user,
  2026-09-16).** Said of `mem:state`'s baseline table, flagged as stale instead of being
  re-measured. This does NOT loosen the rules above it: a *decision* still belongs to the
  user, and an option still needs a verdict rather than a unilateral pick. It is about
  **facts** — a stale number, a comment contradicted by the code, a memory naming a cause
  that measurement refuted. If you can establish the true value, establish it and say what
  you changed; notifying without fixing makes the user the courier of your own finding. When
  the true value costs a measurement, take the measurement.
- **`mem:state`'s verification baseline is re-measured and rewritten on sight, without asking
  (user, 2026-09-21).** Said after being told the table was stale and offered the refresh:
  *"refais cette section systématiquement quand elle est périmée, pas besoin de me le dire à
  chaque fois"*. So it is neither a proposal nor an announcement — notice it, run the pass,
  rewrite the section, and say what changed afterwards. The table's own rule still governs
  HOW: the whole thing in ONE pass, never patched figure by figure — `pnpm test`, unit,
  conformance on both engines, `tsc`, `biome ci`, `pnpm docs:vfs` with its
  `git diff --exit-code`, and the matrix result. The standing exception to "a question is
  answered, not acted on": this one the user has already answered.
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

- **An upstream PR's title starts with the VFS it concerns (user, 2026-09-27):**
  `OPFSWriteAheadVFS: read the WAL to its end when a read transaction begins`. Every PR from then
  on, in the draft's suggested title as in the PR itself.

- **Upstream contributions stand on upstream's own evidence (user, 2026-09-15).** A PR to
  wa-sqlite does not cite this library — a stable library is not argued from an unstable one — and
  its measurements must be reproducible with wa-sqlite alone, best as a test in its own suite that
  fails on its master. **Claude's part is never stated in a PR body, comment or issue (user,
  2026-09-29):** Claude co-signs every commit, and that is disclosure enough. **Claude ticks
  the licence checkboxes of its PR template itself when submitting (user, 2026-09-29)** — until
  then they were the user's to tick. Drafts go in `.scratchpad/`.

  **Not citing this library means not citing it at all (user, 2026-09-23).** No "How this was found"
  section, no "in a library built on wa-sqlite", no provenance of any kind: the maintainer's question
  is whether the change is right for their code, and non-reproducible downstream numbers invite a
  reviewer to weigh evidence they cannot check. Grep the body AND every commit message for the
  library's name before submitting. **And the body must carry an arm the maintainer can run in their
  own checkout, executed by us first** — see `mem:lessons`, "a measurement the maintainer cannot
  rerun is not evidence for them".

  **The report in `docs/upstream/` is written AFTER the PR is opened, named with its number from
  the start (user, 2026-09-21).** Not before, and not under a numberless name to be renamed later:
  the number belongs in the file name, the title, the table row and the "Posted upstream" section,
  so writing the file first means touching all four twice. Said after #357's report was written
  while the branch was still local, then `git mv`-ed — the history carries that once. What DOES
  belong before the PR: the branch, the test that fails on upstream's master, and the PR body
  draft in `.scratchpad/`.

- **A reply to a maintainer's review carries a friendly word (user, 2026-09-30).** Not a bare
  "Done": thank him and answer his own tone — *"un petit message sympa quand-même"*. And nothing the
  dates contradict: "so quickly" was cut from a reply to a review that came eleven days after the
  PR. Every body is shown to the user before it is posted, and the re-request of the review is
  the user's click (`mem:state`, Tooling). **But sparingly (user, 2026-10-01): "vas-y molo sur
  les thanks"** — one thank-you in a set of replies, not one per thread; "Taken as written." is a
  whole reply.

- **An argument goes upstream only once measured, and SQLite is cited at the version wa-sqlite
  builds (user, 2026-10-01).** *"Fais plutôt la vérification avant histoire de répondre avec des
  infos fiables"* — a claim read off SQLite's source is probed before it is posted. The version is
  `SQLITE_VERSION` in wa-sqlite's `Makefile` at upstream's head (3.53.0 on that date), and the
  links go to the `sqlite/sqlite` GitHub mirror at that tag: sqlite.org's source pages answer a
  script with a robot check, so what they show cannot be verified before linking.

- **A report does not end on "not measured" for something that bears on the subject (user,
  2026-09-30).** *"Pourquoi tu gardes du non-mesuré si c'est pertinent ?"* — asked after a campaign
  delivered with three items tagged unmeasured, each of which took minutes. Measure it, or say what
  blocks the measurement and what was tried; a harness limit is tried before it is declared.
- **In chat, a PR or issue number is a link to it (user, 2026-09-30)**, every occurrence —
  `[#368](https://github.com/rhashimoto/wa-sqlite/pull/368)`. Files keep their own conventions.

- **Open questions stay in the backlog; each wave's own brainstorming raises them when it
  gets there** (user, 2026-08-17). Do not front-load a decision session for a wave that is
  not the next one.
- **Finish the subject in hand before putting anything else in front of them (user,
  2026-09-16).** Asked after a six-item list of pending decisions was laid out while the
  matrix test work was still open: *"tu peux éviter de me proposer d'autres choses avant
  qu'on ait réglé ça ?"*. A backlog inventory is not progress, and answering "what should I
  decide?" with everything that is technically undecided hands the triage back to the user.
  **While a subject is live, the only things to raise are the ones that block it.** Everything
  else stays in `mem:follow-ups`, which exists precisely so it does not have to be said aloud.
  This does not cancel the verdict rule above — when they ask for options, still recommend;
  just do not manufacture the occasion.
