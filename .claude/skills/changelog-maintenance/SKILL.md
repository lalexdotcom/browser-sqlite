---
name: changelog-maintenance
description: Maintain a project's CHANGELOG over its whole lifecycle — keep [Unreleased] accurate as changes land, catch it up from git history, and cut releases (stable or alpha/beta/rc) with correct consolidation of prereleases. ALWAYS use when the user declares a new version or freezes the current state as a version, even without mentioning the changelog — e.g. "freeze this as 2.0.0-beta.1", "consider this code the next beta", "this is the rc", "let's ship 1.3.0", "bump the version", "tag a release", "on fige en 2.0.0-beta.1", "considère ce code comme la prochaine beta", "on passe en rc", "on sort la 1.3.0". Also use for "update/sync the changelog", "release notes", "consolidate the betas", or after merging a user-visible change.
---

# Changelog maintenance

## The one rule

**Every section of the changelog describes the net difference, as seen by a user, between the previous published release and the state it represents.**

Everything below applies this rule to three situations:

| Section | Compared against |
|---|---|
| `[Unreleased]` | The most recent published release (stable or prerelease), i.e. the latest release tag |
| A prerelease (`2.0.0-beta.2`) | The previous release of any channel (`2.0.0-beta.1`, or the last stable if first of the cycle) |
| A stable release (`2.0.0`) | The **previous stable** (`1.4.3`), ignoring every prerelease in between |

A user never experienced anything that was never published, so it must never appear as a change.

## Before any operation: learn the project's conventions

Read the whole existing CHANGELOG (header, several release sections, and the bottom of the file) and write down, before editing, the conventions it uses. Match every one of them exactly; the new content must be indistinguishable in form from what is already there.

Convention checklist:

- **Format**: Keep a Changelog, conventional-changelog, or free-form.
- **File header**: intro paragraph, links to Keep a Changelog / Semantic Versioning. Keep it untouched.
- **Release heading**: exact shape, e.g. `## [1.2.0] - 2026-09-30`, `## 1.2.0 (2026-09-30)`, `## v1.2.0`; bracketed or not; `v` prefix or not; date format and separator.
- **Unreleased heading**: `## [Unreleased]`, `## Unreleased`, or absent.
- **Subsection headings**: level (`###`), names, casing and order (e.g. Added, Changed, Deprecated, Removed, Fixed, Security); whether empty subsections are omitted.
- **Entry style**: bullet character, tense/mood, capitalisation, trailing period, backticks for code, scope prefixes (`**cli:**`), PR/issue/commit/author references and their exact format.
- **Links**: whether headings are link references, and the link definitions at the bottom of the file:
  - URL pattern (host, compare path, tag prefix), e.g. `https://github.com/owner/repo/compare/v1.1.0...v1.2.0`
  - the `[Unreleased]` link pattern, e.g. `.../compare/v1.2.0...HEAD`
  - the link for the very first release (often `.../releases/tag/v0.1.0`)
  - their order (usually newest first) and whether prerelease sections have links
  Derive the pattern from existing links; if there are none but the format expects them, derive host and path from `git remote get-url origin` and the tag prefix from existing tags.
- **Prerelease sections**: kept or replaced after the stable release, in past cycles.
- **Line endings and trailing blank lines**: preserve.

If there is no changelog, create one in Keep a Changelog 1.1.0 format: standard header, `## [Unreleased]`, subsections Added, Changed, Deprecated, Removed, Fixed, Security (omit empty ones), headings `## [X.Y.Z] - YYYY-MM-DD`, and link definitions at the bottom for `[Unreleased]` and every release. Confirm with the user before creating it.

Find the latest release tags (adapt the prefix to the repo's convention):

```sh
git tag --sort=-v:refname
```

```sh
git tag --sort=-v:refname | grep -vE -- '-(alpha|beta|rc|pre|next|canary)'
```

Never rewrite the content of a published section. The only allowed edits there are fixing broken links or typos, and only when the user asks.

Then pick the operation that matches the request.

---

## Operation A — Update `[Unreleased]` for a change

Use when a user-visible change has landed or is about to (a PR, a commit, a described change).

1. **Decide if it belongs in the changelog at all.** Skip internal refactors, tests, CI, tooling and docs typos unless the project's changelog already records such things. When in doubt, ask.
2. **Check whether the change touches something already in `[Unreleased]`.** This is the heart of maintenance: the section is edited, not appended to.

| Situation | Action on `[Unreleased]` |
|---|---|
| New user-visible change, unrelated to existing entries | Add an entry in the right section |
| Modifies something already listed as `Added` (rename, new option, reshaped API) | **Rewrite** that `Added` entry to describe the new final state; add nothing else |
| Fixes a bug in something listed as `Added` | **Add nothing** — the bug was never published |
| Fixes a bug introduced by an unreleased `Changed` entry | **Add nothing**; adjust the `Changed` entry if its description is now inaccurate |
| Removes or reverts something listed in `[Unreleased]` | **Delete** that entry; add nothing |
| Restores behaviour that an unreleased `Changed`/`Removed` entry altered | **Delete** that entry |
| Changes again something already listed as `Changed` | **Rewrite** it as "latest release behaviour → new behaviour"; delete it if the net result is no change |
| Fixes a bug that exists in the latest published release | Add a `Fixed` entry |
| Bumps a dependency already bumped in `[Unreleased]` | Update the existing entry to the new final version |
| Deprecates something added in `[Unreleased]` | Usually just remove it from `Added` if it will not be supported; otherwise mention it once, as shipped |

3. **When unsure whether something was published**, check the latest release tag rather than guessing:

```sh
git show <latest-tag>:path/to/file
```

```sh
git log <latest-tag>..HEAD -S'symbolName' --oneline
```

4. Keep the section clean: remove empty subsections, merge duplicates, keep one change per line.

## Operation B — Catch up / audit `[Unreleased]`

Use when the section has drifted ("sync the changelog", "is the changelog up to date?", before a release).

1. List what happened since the latest release tag:

```sh
git log <latest-tag>..HEAD --no-merges --format='%h %s'
```

```sh
git diff --stat <latest-tag>..HEAD
```

   Also check merged PRs, changesets or fragment files if the repo uses them.
2. For each user-visible change missing from `[Unreleased]`, apply Operation A in chronological order (oldest first), so that later changes rewrite or cancel earlier ones naturally.
3. **Verify every existing entry against `git diff <latest-tag>..HEAD`.** Remove or rewrite entries that are no longer true (reverted work, renamed APIs, fixes for bugs that were never published).
4. Report to the user what was added, rewritten and removed, briefly.

## Operation C — Cut a release

Run Operation B first so `[Unreleased]` is accurate, then resolve the target version.

### Resolving the target version

**1. Find the current version** from every source available, and compare them:

- Release tags: `git tag --sort=-v:refname`
- Version field of the package manifest(s) (`package.json`, `Cargo.toml`, `pyproject.toml`, `*.csproj`, `pom.xml`, `version.txt`, …), including every package in a monorepo
- Headings of the CHANGELOG

If they disagree (e.g. manifest says `2.0.0-beta.2`, latest tag is `2.0.0-beta.1`, changelog stops at `1.4.3`), stop and ask which one is authoritative.

**2. Compute the target:**

| Request | Current version | Target |
|---|---|---|
| Explicit version ("freeze as 2.0.0-beta.1") | any | That version, after the consistency checks below |
| "Next beta" / "next rc" / "next alpha" | Inside that channel (`2.0.0-beta.1`) | Increment the counter (`2.0.0-beta.2`) |
| "Next rc" | Inside an earlier channel (`2.0.0-beta.3`) | Same base, new channel at 1 (`2.0.0-rc.1`) |
| "Next beta" | Inside a later channel (`2.0.0-rc.1`) | Unusual: ask |
| "Next beta" / "next release" | A stable version (`1.4.3`) | **Ambiguous base: ask.** Propose a base from `[Unreleased]` using semver (breaking → major, `Added` → minor, only fixes → patch), and let the user pick |
| "Stable" / "final" / "ship it" | Inside a prerelease cycle (`2.0.0-rc.2`) | The base version (`2.0.0`) |

Follow the project's prerelease format (`-beta.1`, `-beta1`, `b1`, `-beta`…) as seen in existing tags; ask if there is no precedent.

**3. Consistency checks for any target**, explicit or computed:

- The version must not already exist as a tag or changelog section.
- It must be greater than the current version by semver ordering.
- A major/minor bump should match the content (e.g. `[Unreleased]` contains breaking changes but the target is a patch or minor after 1.0 → warn).
- The previous stable must exist when going to a stable after prereleases (it is the consolidation baseline).

**4. Confirm when not certain.** State the resolved version, the source it came from and the baseline it will be compared against, and **ask for confirmation before editing anything** whenever the version was inferred rather than given explicitly, any check above failed, or sources disagreed. Only proceed without asking when the user gave an explicit version and all checks pass.

**5. Scope.** This skill edits the CHANGELOG. If the project's convention also bumps the version in manifests, offer to do it (or do it if the user asked for it). Never create tags, commit, push or publish without explicit confirmation.

Then pick the matching procedure.

### C1 — Prerelease, or stable with no prerelease in between

The previous release is the baseline, which is exactly what `[Unreleased]` is compared against, so:

1. Rename `[Unreleased]` to `[<version>] - <YYYY-MM-DD>`.
2. Insert a new empty `[Unreleased]` section above it.
3. Update comparison links: `[Unreleased]` compares `<version>...HEAD`; the new section compares `<previous-tag>...<version>`.

If `[Unreleased]` is empty, tell the user there is nothing user-visible to release rather than inventing content.

### C2 — Stable release after one or more prereleases

The baseline is the **previous stable**, not the last prerelease, so the entry must be consolidated across the whole cycle.

1. **Gather** every candidate change: all prerelease sections of the cycle, `[Unreleased]`, and `git log <previous-stable>..HEAD`.
2. **Build a ledger** (a working table, not part of the output) tracking each subject across the cycle:

| Subject | beta.1 | beta.2 | rc.1 | Unreleased | In previous stable? | Net result |
|---|---|---|---|---|---|---|

3. **Resolve** each row:

| Lifecycle inside the cycle | Net result in the stable entry |
|---|---|
| Added, later removed / reverted | **Omit entirely** |
| Added, later renamed or reshaped | One `Added` entry describing the **final** shape |
| Added, later had a bug fixed | One `Added` entry; **omit the fix** |
| Bug introduced and fixed within the cycle | **Omit** |
| Bug present in previous stable, fixed | `Fixed` |
| Bug present in previous stable, fixed, fix reverted | **Omit** |
| Existing behaviour changed, then changed again | One `Changed` entry: previous stable → final behaviour |
| Existing behaviour changed, then restored | **Omit** |
| Existing feature removed, then restored | **Omit** (or `Changed` if behaviour differs) |
| Breaking change introduced, then reverted | **Omit**; do not flag the release as breaking for it |
| Vulnerability introduced and fixed within the cycle | **Omit** |
| Vulnerability present in previous stable, fixed | `Security` |
| Dependency bumped several times | One entry: previous stable version → final version |

4. **Verify** every line against `git diff <previous-stable>..HEAD`. Re-derive breaking changes from that diff, not from the prerelease sections. Look for user-visible changes no source mentioned.
5. **Write** the stable section:
   - Describe final behaviour for users upgrading from the previous stable, not the path taken.
   - Never mention prerelease versions ("fixed in beta.2", "since rc.1").
   - Breaking changes first, explicit, with migration hints.
6. **Handle the prerelease sections** as the project did before. With no precedent, ask the user:
   1. **Replace** them with the single stable section (cleanest for users).
   2. **Keep** them below the stable section, unchanged, as history.
7. Insert a new empty `[Unreleased]`, and update comparison links (the stable link compares against the previous stable).

---

## Final check — after every edit, whatever the operation

Re-read the changed parts of the file and verify, fixing anything that fails:

- [ ] Every new or renamed heading has exactly the same shape as existing ones (brackets, `v` prefix, date format).
- [ ] If headings are link references, **every** one of them has a matching definition at the bottom, including `[Unreleased]` and each new release.
- [ ] The `[Unreleased]` link compares the **new latest tag** to `HEAD`.
- [ ] The new release link compares its baseline to the new tag: the previous release for a prerelease, the **previous stable** for a stable after prereleases (and follows the project's precedent if it did otherwise).
- [ ] Link definitions are in the same order and URL pattern as the existing ones; no duplicate, no stale reference left behind (e.g. links to prerelease sections that were removed).
- [ ] Subsections follow the project's order and names; no empty subsection unless the project keeps them.
- [ ] Entries follow the project's entry style and reference format.
- [ ] Published sections are unchanged (check with `git diff` on the changelog).

## Worked example

Latest stable `2.5.1`. Cycle towards `3.0.0`:

- beta.1: Added `exportCsv()`. Added `--verbose` flag. Changed default timeout from 30s to 10s.
- beta.2: Fixed `exportCsv()` crashing on empty input. Removed `--verbose` (replaced by `--log-level`). Fixed a memory leak in the watcher (present since 2.3).
- rc.1: Renamed `exportCsv()` to `toCsv()`. Changed default timeout back to 30s.

**Between rc.1 and the stable release**, a commit adds a `delimiter` option to `toCsv()`, then another fixes a bug in that option. `[Unreleased]` (compared to rc.1) ends up as:

```md
## [Unreleased]

### Changed
- `toCsv()` accepts a `delimiter` option.
```

The fix to `delimiter` adds nothing: the option was never published.

**Stable ledger resolution** (compared to 2.5.1):

- `exportCsv` → added, fixed, renamed, extended → one `Added` entry for `toCsv()` with its final options.
- `--verbose` → added then removed → omitted; `--log-level` is the net addition.
- Timeout → changed then restored → omitted.
- Watcher leak → existed in 2.5.1 → `Fixed`.

```md
## [Unreleased]

## [3.0.0] - 2026-10-01

### Added
- `toCsv()` to export results as CSV, with a configurable `delimiter`.
- `--log-level` flag to control output verbosity.

### Fixed
- Memory leak in the file watcher.

<!-- … older sections … -->

[Unreleased]: https://github.com/owner/repo/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/owner/repo/compare/v2.5.1...v3.0.0
[2.5.1]: https://github.com/owner/repo/compare/v2.5.0...v2.5.1
```

Here the prerelease sections were replaced, so their link definitions were removed too, and the `3.0.0` link compares against the previous stable.

By contrast, the `3.0.0-rc.1` section legitimately says "Renamed `exportCsv()` to `toCsv()`" and "Restored default timeout to 30s", because rc users upgrade from beta.2.
