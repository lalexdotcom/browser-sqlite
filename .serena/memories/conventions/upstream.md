# Conventions — contributing to wa-sqlite

Part of `mem:conventions`, moved out of it as written on 2026-10-13 when that memory neared 40 000 characters: the upstream rules of its § Working with the user, then those carried over from Claude's auto-memory. What was sent, and its reports: `mem:upstream`.

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
  the user's click (`mem:stack-and-build`, Devcontainer). **But sparingly (user, 2026-10-01): "vas-y molo sur
  les thanks"** — one thank-you in a set of replies, not one per thread; "Taken as written." is a
  whole reply.

- **An argument goes upstream only once measured, and SQLite is cited at the version wa-sqlite
  builds (user, 2026-10-01).** *"Fais plutôt la vérification avant histoire de répondre avec des
  infos fiables"* — a claim read off SQLite's source is probed before it is posted. The version is
  `SQLITE_VERSION` in wa-sqlite's `Makefile` at upstream's head (3.53.0 on that date), and the
  links go to the `sqlite/sqlite` GitHub mirror at that tag: sqlite.org's source pages answer a
  script with a robot check, so what they show cannot be verified before linking.

- **Upstream first, then the patch (2026-10-05).** A wa-sqlite change is validated on wa-sqlite's own suite (both engines), sent as a PR (body shown to the user, fork branch pushed for review), and only then carried in `patches/`. A plan listing "carry the patch" before "PR upstream" is reordered before starting. **This orders the steps of a wa-sqlite change; it is not a preference for one (user, 2026-10-08):** a solution that avoids changing upstream is better; upstream is studied when it is the only solution or the best-performing one — "on ne s'interdit pas de changer upstream si c'est la meilleure solution".
- **Nothing goes upstream with an open unknown (2026-09-30).** Name each thing the result does not explain, find its cause, measure it, then write; "not reproduced after a bounded search" is an acceptable answer, stated as such.
- **A known conflict with another of our open PRs is stated in the PR (2026-10-03):** which parts of which file both touch, and that we rebase whichever merges second, so the maintainer picks the order.
- **Upstream replies are warm, lightly (2026-09-30).** Thank for the review, say what it led to, offer help where it fits — one friendly touch per message; the PR description itself stays factual.
- **Fork commits use the current identity (2026-09-30).** On the wa-sqlite fork, author with the identity the library repo has configured at commit time (`-c user.name=… -c user.email=…` from `git -C /workspaces/wsqlite config`), never copied from the branch's older commits and never written into the fork's config.
