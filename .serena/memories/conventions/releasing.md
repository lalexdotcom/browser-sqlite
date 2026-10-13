# Conventions — releasing (user, 2026-08-31)

Part of `mem:conventions`, moved out of it as written on 2026-10-13 when that memory neared 40 000 characters.

**The `changelog-maintenance` skill is the authority on `CHANGELOG.md` (user,
2026-10-06)**: what goes in `[Unreleased]`, cutting a release, consolidating the rc
sections into `## [1.0.0] - <date>`. Where this file and the skill differ, the skill
wins — this section predates it. So a release reopens an empty `## [Unreleased]`
with its link at once, as the skill does; rc.6 was cut without one by following
the old wording here, and it was reopened the same day. No automation writes the
file: the workflow reads it, and the action receives a file path and never learns
where it came from.

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

**Pushing `main` and the tag in one command or in two is the same since 2026-10-13**: `pre-push` runs the suite only for a commit made on a branch directly (the bump commit is one) and the consumer smoke for a `v*` tag, and the release reuses the CI and matrix runs of the push of `main` (its `prior` job), running its own only when none passed.

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
version number; do not reorder it back. Proved twice by rc.4, which failed once before anything
existed and once with the GitHub Release created but `npm publish` refused.
**The action is not idempotent, and nothing fixes that yet**: once the release exists, re-running
the job fails at `gh release create` before reaching npm. Recovery is to delete the release and the
tag, then retag. A `gh release view … || gh release create …` in the action would make a partial
failure replayable; it is not written.

**Do not add `set -e` to the extraction step.** Two reviews have proposed it and it
was refused both times: under `pipefail` it would abort
`PKG=$(grep '"version"' package.json | …)` silently when the grep finds nothing,
replacing a diagnosable `tag vX != package.json ()` with no message at all. The
only path it would newly protect — a missing `CHANGELOG.md` — is already caught
by the emptiness test. That test is `grep -q '[^[:space:]]'` and **not `[ -s ]`**,
because a section holding one blank line is one byte long and `-s` calls it
non-empty; this was found by running the block against a fixture, not by reading it.

Design: `docs/superpowers/specs/2026-08-31-release-notes-from-changelog-design.md`.
