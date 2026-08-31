# Release notes from CHANGELOG.md — design

**Date:** 2026-08-31
**Status:** approved, unbuilt

## The problem

A tag `v*.*.*` pushed to this repository triggers
`.github/workflows/release-and-publish.yaml`, which calls
`lalexdotcom/action-release-and-publish` (pinned by SHA). That action publishes to
npm with the right dist-tag, marks prereleases, and creates a GitHub Release with
`--generate-notes` — GitHub's own summary, built from merged pull requests. This
repository's history is direct commits and merges of local feature branches, so
that summary reduces in practice to a `Full Changelog` compare link.

`CHANGELOG.md` is where the release is actually described, and nothing reads it.
The action has no input for a release body, so the description a consumer would
want has no path to the release page.

## The invariant this design is built on

**No automation writes to `CHANGELOG.md`.** The workflows in this repository only
read it; the action in the other repository never sees it at all — it receives a
file path. Every edit to the file is a human act, or the agent's under
instruction: dating a heading at bump time, opening a new section, consolidating
the release-candidate sections into a final one.

This is what keeps the file editorial. A changelog that a script can rewrite
stops being written for the reader, and there is no rule that could tell a script
which entries of a stabilisation cycle still matter at 1.0.0.

## Piece 1 — the action gains an optional input, and loses an ordering mistake

Repository: `lalexdotcom/action-release-and-publish`, a composite action
(`action.yml`, no build output). It releases itself on push to `main` from
conventional commits; its `AGENTS.md` is authoritative for commit format there,
and notes that a `!` suffix is not detected — a breaking change needs a
`BREAKING CHANGE:` footer. Neither change here is breaking.

### 1a. `release-notes-file`

A new optional input naming a file whose content becomes the release body.

```
notes-file provided     ->  gh release create "$TAG" --notes-file "$FILE" --generate-notes [--prerelease]
notes-file absent       ->  gh release create "$TAG" --generate-notes                      [--prerelease]
notes-file not readable ->  exit 1
```

**A file path, not a string.** A `release-notes` string input would reach the
step as `${{ inputs.release-notes }}`, which GitHub interpolates textually into
the shell script. A changelog containing backticks or `$(...)` — and this one is
full of backticks — would execute on a runner holding `NPM_TOKEN`. A path has no
such reading, and it is passed through `env:` rather than interpolated.

**`--generate-notes` stays**, deliberately, so the `Full Changelog` compare link
keeps appearing under the supplied body. The appended block is whatever GitHub
generates: today, for this repository, essentially that link. If this repository
ever merges real GitHub pull requests, their list will appear there too — an
accepted consequence, visible on the first release that has one.

**A named but unreadable file fails the job.** It must never fall back to
`--generate-notes`: an empty or wrong release body is only noticed after
publication.

**Backward compatible.** Without the input, behaviour is byte for byte today's,
so no other consumer of the action is affected.

### 1b. The GitHub Release is created before `npm publish`

Today `Publish to NPM` (`action.yml:141`) runs before `Create GitHub Release`
(`:181`). That is the irreversible step first.

- Today, if release creation fails: the version is on npm permanently, with no
  notes, and retrying costs a burnt version number.
- Reordered, if publishing fails: a release exists for a version absent from npm.
  Delete it, fix, retag. Nothing is permanent.

The release step moves to **just before `Publish to NPM`** — after `Build` and
after `Validate inputs for publishing`, so a broken build or a missing token
leaves no release behind either.

**The one interaction that could have bitten does not.** `Get latest stable
release` (`:149`) queries the releases API to decide whether to add the `latest`
dist-tag, so creating the release earlier could change its answer. It cannot: the
filter is `select(.prerelease == false)`, which excludes a prerelease created
moments earlier, leaving `LATEST` unchanged — including in the "no stable exists,
tag it `latest` anyway" branch. For a stable version the `type == "stable"`
condition is already true regardless. Neither path moves.

## Piece 2 — this repository extracts the section, in shell

One `run:` step in `.github/workflows/release-and-publish.yaml`, between the
existing `checkout` and the action's `uses:`. **Inline shell, not a file in
`scripts/`**: the workflow stays self-contained and does not depend on the
repository's tooling surviving unchanged.

```bash
VERSION="${GITHUB_REF_NAME#v}"

# Three things must name the same version: the tag, package.json, and a dated
# CHANGELOG heading. The action publishes the version it reads from package.json
# and validates the tag separately, so nothing else checks that they agree.
PKG=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
[ "$PKG" = "$VERSION" ] || { echo "::error::tag $GITHUB_REF_NAME != package.json ($PKG)"; exit 1; }

HEADING=$(awk -v ver="$VERSION" 'index($0, "## " ver " — ") == 1 { print; exit }' CHANGELOG.md)
[ -n "$HEADING" ] || { echo "::error::no CHANGELOG heading for $VERSION"; exit 1; }
case "$HEADING" in
  *" — "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "::error::CHANGELOG heading for $VERSION is not dated: $HEADING"; exit 1 ;;
esac

FILE="$RUNNER_TEMP/release-notes.md"
awk -v ver="$VERSION" '
  index($0, "## " ver " — ") == 1 { found=1; next }
  found && index($0, "## ") == 1  { exit }
  found                           { print }
' CHANGELOG.md > "$FILE"
grep -q '[^[:space:]]' "$FILE" || { echo "::error::CHANGELOG section for $VERSION is empty"; exit 1; }
```

The path is then passed to the action as `release-notes-file`, and the pinned SHA
is repointed to the action's new release.

**Prefix comparison, not a regex.** `1.0.0-rc.4` contains dots, which are regex
metacharacters; `index($0, ...) == 1` is exact and carries the em dash literally.

**The heading format is the contract:** `## <version> — <date>`, em dash U+2014,
matching `## 1.0.0-rc.3 — 2026-03-26` already in the file. The body is everything
up to the next `## `.

**Emptiness is tested for content, not for size.** `[ -s ]` was the obvious
check and it is wrong: a section holding nothing but a blank line is one byte
long, so `-s` calls it non-empty and the release ships with a blank body. Found
by running the block below against a fixture, not by reading it. `grep -q
'[^[:space:]]'` is the test that means what the sentence above means.

**The date is validated, not merely tolerated.** The prefix match alone would
accept `## 1.0.0-rc.4 — TBD`, and `## Unreleased — 1.0.0-rc.4` — the shape the
file carries *before* a bump — would correctly not match, since its prefix is
`## Unreleased`. Requiring `YYYY-MM-DD` is what makes "this version has been
released" a statement the workflow can check rather than assume. Trailing
whitespace after the date fails the match; that strictness is the point, and the
formatter already trims it.

**Why the step sits before the action** even though piece 1b already moves the
irreversible operation later: it is where the three-way version check lives, and
that check has no other home — the action sees neither the CHANGELOG nor any
reason to compare the tag with `package.json`. It is the belt to 1b's braces.

## Piece 3 — the bump ceremony

`upversion` is not used for this package. The agent performs the bump under
instruction:

1. Edit `CHANGELOG.md`: date the existing heading, `## Unreleased — 1.0.0-rc.4`
   becoming `## 1.0.0-rc.4 — <date>`. **No new section is opened** — a fresh
   `## Unreleased` appears only when the user asks for one.
2. Edit `package.json` to the same version, **in the same commit**: the extraction
   step requires both to be true of one tree.
3. Tag `v<version>`.
4. The user pushes. Pushing remains their call, as everywhere else in this
   repository.

Consolidating the release-candidate sections into a single `## 1.0.0 — <date>` at
the final release is the same kind of act: instructed, editorial, and outside
anything described here.

## Failure modes, and where each lands

| What goes wrong | Where it stops | Cost |
|---|---|---|
| Tag does not match `package.json` | extraction step, before the action | nothing published |
| No CHANGELOG heading for the version | extraction step | nothing published |
| Heading present but undated | extraction step | nothing published |
| Heading dated but section blank | extraction step | nothing published |
| Build or missing token | action, before the release step | nothing published |
| `gh release create` fails | action, before `npm publish` | delete release, retag |
| `npm publish` fails | action, after the release | delete release, retag |

## Out of scope

- Any automation that writes `CHANGELOG.md`.
- A script in `scripts/` for extraction.
- `upversion` for this package.
- Changing dist-tag selection, prerelease detection, or the `pages` job, all of
  which are already correct.

## Verification

The action's two changes are verified by its own release and by the first tag
pushed here: the release page for `v1.0.0-rc.4` must carry the CHANGELOG section
followed by the compare link, and the npm publish must have happened after the
release appeared.

The extraction was verified before any of that, locally, by running the block
against the real `CHANGELOG.md` and against fixtures — all five cases below
behaved as specified on 2026-08-31, and the fifth is what corrected the design:

| case | outcome |
|---|---|
| `1.0.0-rc.3`, dated, present | section extracted |
| `1.0.0-rc.4`, present only as `## Unreleased — 1.0.0-rc.4` | no heading, fails |
| `9.9.9`, absent | no heading, fails |
| heading `## 2.0.0 — TBD` | undated, fails |
| section is the last in the file | extracted to end of file |
| section is a single blank line | passed under `-s`, fails under the content test |

The tag ↔ `package.json` disagreement is verified the same way: tagging
`v1.0.0-rc.4` against a `package.json` reading `1.0.0-rc.3` stops at the first
check.

**Ordering constraint on the work itself:** the action is consumed by SHA, so its
change must be pushed and released before the pin here can be repointed. The two
repositories cannot be updated in one step.
