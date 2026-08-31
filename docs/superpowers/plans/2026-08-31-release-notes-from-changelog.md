# Release Notes From CHANGELOG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tag pushed here produces a GitHub Release whose body is the matching `CHANGELOG.md` section, and npm is never published before that release exists.

**Architecture:** Two repositories. `lalexdotcom/action-release-and-publish` gains an optional `release-notes-file` input and moves its release-creation step ahead of `npm publish`. This repository gains one inline shell step that checks the tag, `package.json` and a dated CHANGELOG heading all name the same version, extracts that section, and hands the path to the action. Nothing writes to `CHANGELOG.md`.

**Tech Stack:** GitHub Actions composite action (YAML + bash), `gh` CLI, `awk`. No new dependency in either repository.

**Spec:** `docs/superpowers/specs/2026-08-31-release-notes-from-changelog-design.md`

## Global Constraints

- **No automation writes to `CHANGELOG.md`.** Workflows read it; the action receives a file path and never sees the file's origin.
- **Inline shell only in this repository's workflow.** No file under `scripts/` may be required for a release to run.
- **The heading contract is `## <version> — <date>`**, em dash U+2014, date `YYYY-MM-DD`. Example already in the file: `## 1.0.0-rc.3 — 2026-03-26`.
- **The action is consumed by SHA.** Its change must be pushed and released before the pin here can be repointed. The two repositories cannot be updated in one commit.
- **The action's repository uses Conventional Commits** and releases itself on push to `main`. Its `AGENTS.md` is authoritative there; a `!` suffix is **not** detected, a breaking change needs a `BREAKING CHANGE:` footer. Neither commit in Task 1 is breaking.
- **This repository's pre-commit hook runs the whole suite** and refuses a red tree, so every commit must land on green.
- **`.work/` is gitignored.** The action clone never dirties this repository.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `.work/action-release-and-publish/action.yml` | the input, and the step order | 1 |
| `.work/action-release-and-publish/README.md` | the per-input `###` section consumers read | 1 |
| `.work/action-release-and-publish/USAGE.md` | the worked example | 1 |
| `.github/workflows/release-and-publish.yaml` | version checks, extraction, the repointed pin | 3 |
| `.serena/memories/conventions.md` | the release procedure and the two-repo ordering | 4 |

**No `CHANGELOG.md` entry for this work.** Its sections describe the published package; a CI change alters nothing a consumer installs.

---

### Task 1: The action gains `release-notes-file` and creates the release before publishing

Work happens in the clone at `.work/action-release-and-publish` (already present; if not: `git clone https://github.com/lalexdotcom/action-release-and-publish.git .work/action-release-and-publish`). **Nothing is pushed in this task.**

**Files:**
- Modify: `.work/action-release-and-publish/action.yml` — inputs block (after `:26`), and the `Create GitHub Release 🎉` step (`:181-193`) moved to sit between `Validate inputs for publishing 🔐` (`:127-139`) and `Publish to NPM 🚀` (`:141-147`)
- Modify: `.work/action-release-and-publish/README.md` — a new `### `release-notes-file`` section
- Modify: `.work/action-release-and-publish/USAGE.md` — example
- Test: `$SCRATCH/argv-probe.sh` where `SCRATCH=/tmp/claude-1000/-workspaces-wsqlite/28e03af0-53be-4c7b-adca-5a927eb11add/scratchpad` (throwaway, committed nowhere)

**Interfaces:**
- Produces: an action input named exactly `release-notes-file`, optional, whose value is a filesystem path readable by the runner. Task 3 passes `${{ steps.notes.outputs.file }}` to it.

- [ ] **Step 1: Write the failing argv probe**

The action has no test suite, so the testable unit is the argument list the step builds. Extract it into a throwaway script that prints argv instead of calling `gh`.

```bash
cat > "$SCRATCH/argv-probe.sh" <<'EOF'
set -uo pipefail
# Mirrors the Create GitHub Release step. Prints argv instead of running gh.
TAG="$1"; IS_PRERELEASE="$2"; NOTES_FILE="${3-}"

ARGS=(--generate-notes)
if [[ "$IS_PRERELEASE" == "true" ]]; then
  ARGS+=(--prerelease)
fi
if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -r "$NOTES_FILE" ]]; then
    echo "ERR not readable: $NOTES_FILE"
    exit 1
  fi
  ARGS+=(--notes-file "$NOTES_FILE")
fi
printf 'gh release create %s' "$TAG"
printf ' [%s]' "${ARGS[@]}"
printf '\n'
EOF
```

- [ ] **Step 2: Run the probe and confirm all four branches**

```bash
printf 'notes\n' > "$SCRATCH/notes.md"
printf 'notes\n' > "$SCRATCH/a b.md"   # a path with a space
bash "$SCRATCH/argv-probe.sh" v1.0.0-rc.4 true  "$SCRATCH/notes.md"
bash "$SCRATCH/argv-probe.sh" v1.0.0     false "$SCRATCH/notes.md"
bash "$SCRATCH/argv-probe.sh" v1.0.0-rc.4 true  ""
bash "$SCRATCH/argv-probe.sh" v1.0.0-rc.4 true  "$SCRATCH/a b.md"
bash "$SCRATCH/argv-probe.sh" v1.0.0-rc.4 true  "$SCRATCH/missing.md"; echo "exit=$?"
```

Expected, in order:
```
gh release create v1.0.0-rc.4 [--generate-notes] [--prerelease] [--notes-file] [.../notes.md]
gh release create v1.0.0 [--generate-notes] [--notes-file] [.../notes.md]
gh release create v1.0.0-rc.4 [--generate-notes] [--prerelease]
gh release create v1.0.0-rc.4 [--generate-notes] [--prerelease] [--notes-file] [.../a b.md]
ERR not readable: .../missing.md
exit=1
```

The fourth case is why the step must use a bash **array** and not the string `ARGS="$ARGS --notes-file $FILE"` it uses today: word-splitting would turn `a b.md` into two arguments.

- [ ] **Step 3: Add the input to `action.yml`**

Insert after the `github-token` input (`:24-26`), keeping the file's two-space indentation:

```yaml
  release-notes-file:
    description: Path to a file whose content becomes the GitHub Release body. Generated notes are appended after it. When omitted, generated notes are used alone.
    required: false
```

- [ ] **Step 4: Move and rewrite the release step**

Delete the `Create GitHub Release 🎉` step at `:181-193`, and insert this between `Validate inputs for publishing 🔐` and `Publish to NPM 🚀`:

```yaml
    - name: Create GitHub Release 🎉
      shell: bash
      run: |
        TAG="${{ steps.validate.outputs.tag }}"
        IS_PRERELEASE="${{ steps.prerelease.outputs.is_prerelease }}"

        # An array, not a string: a notes path containing a space would be
        # word-split into two arguments.
        ARGS=(--generate-notes)
        if [[ "$IS_PRERELEASE" == "true" ]]; then
          ARGS+=(--prerelease)
        fi

        # NOTES_FILE arrives through env, never through ${{ }} interpolation:
        # an interpolated value is pasted into this script, so a body holding
        # backticks or $(...) would execute on a runner holding NPM_TOKEN.
        if [[ -n "$NOTES_FILE" ]]; then
          if [[ ! -r "$NOTES_FILE" ]]; then
            echo "❌ Error: release-notes-file not readable: $NOTES_FILE"
            exit 1
          fi
          ARGS+=(--notes-file "$NOTES_FILE")
        fi

        gh release create "$TAG" "${ARGS[@]}"
      env:
        GITHUB_TOKEN: ${{ inputs.github-token }}
        NOTES_FILE: ${{ inputs.release-notes-file }}
```

The step is created before `npm publish` so the irreversible operation runs last: a failure here costs a deleted release and a retag, where the current order costs a burnt npm version number.

- [ ] **Step 5: Confirm the step order reads correctly**

```bash
grep -n '^    - name:' .work/action-release-and-publish/action.yml
```

Expected order: `Validate version tag`, `Determine if prerelease`, `Detect package manager`, `Set pnpm (if needed)`, `Use Node LTS`, `Install dependencies`, `Build`, `Extract version and prerelease type`, `Validate inputs for publishing`, **`Create GitHub Release`**, `Publish to NPM`, `Get latest stable release`, `Add dist-tags if applicable`.

- [ ] **Step 6: Update `README.md` and `USAGE.md`**

The README documents one input per `###` subsection — it is **not** a table. Insert after the `### `github-token`` block and before `## Requirements`, matching that shape exactly:

````markdown
### `release-notes-file`

**Optional** | Default: none

Path to a file whose content becomes the GitHub Release body. GitHub's generated
notes are appended after it, so the `Full Changelog` link is preserved. When
omitted, generated notes are used alone. The file is produced by your own
workflow — this action only reads the path.

The job fails if the path is set but unreadable, rather than falling back to
generated notes: an empty release body is only noticed after publication.

```yaml
- uses: lalexdotcom/action-release-and-publish@v1
  with:
    release-notes-file: ${{ steps.notes.outputs.file }}
```
````

In `USAGE.md`, add this under `## Common Scenarios`, after `### Custom NPM registry`:

````markdown
### Release body from your own file

The action reads the path; producing the file is your workflow's job.

```yaml
- name: Build the release body 📝
  id: notes
  shell: bash
  run: |
    # e.g. the section of CHANGELOG.md matching this tag
    echo "file=$RUNNER_TEMP/release-notes.md" >> "$GITHUB_OUTPUT"

- uses: lalexdotcom/action-release-and-publish@v1
  with:
    publish: true
    npm-token: ${{ secrets.NPM_TOKEN }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    release-notes-file: ${{ steps.notes.outputs.file }}
```
````

- [ ] **Step 7: Commit, two commits, conventional**

```bash
cd .work/action-release-and-publish
git add action.yml README.md USAGE.md
git commit -m "feat(release): accept an optional release-notes-file for the release body

The body is passed as a path, never as a string input: an interpolated
string would be pasted into the step's shell, so release notes holding
backticks or \$(...) would execute on a runner holding NPM_TOKEN. The
argument list becomes a bash array so a path containing a space survives.

Generated notes are kept alongside, which is what preserves the Full
Changelog compare link under a supplied body."

git commit -m "fix(release): create the GitHub Release before publishing to NPM

npm publish is irreversible - a published version number cannot be reused.
Creating the release first means a failure there costs a deleted release
and a retag, where the previous order cost a burnt version.

Get latest stable release is unaffected: it filters on
select(.prerelease == false), so a prerelease created moments earlier is
excluded and LATEST is unchanged, and for a stable version the
type == stable condition is already true regardless."
```

**The two commits touch the same file, so they need staging discipline, not `--allow-empty`.** Either stage `action.yml`'s hunks separately with `git add -p` (the inputs hunk first, the step-move hunk second), or make the edits in two passes — input and docs, commit, then the reorder, commit. If separating them costs more than it is worth, make it one `feat(release):` commit whose body covers both; the release outcome is identical. `feat` and `fix` together yield one **minor** bump, `v1.1.0`.

---

### Task 2: Release the action, and capture the SHA

**Files:** none in this repository.

**Interfaces:**
- Produces: a commit SHA on the action's `main`, and the tag `v1.1.0`. Task 3 pins that SHA.

- [ ] **Step 1: STOP — get the user's explicit go**

Pushing to the action's `main` triggers its release workflow immediately: it tags, moves `v1`/`v1.1`, and publishes a GitHub Release. That is outward-facing and not undoable by a revert. Do not push without the user saying so in this session.

- [ ] **Step 2: Push**

```bash
cd .work/action-release-and-publish
git push origin main
```

- [ ] **Step 3: Wait for the release workflow, then read the SHA**

```bash
sleep 60
git fetch origin --tags
git rev-parse v1.1.0
git tag --list 'v1*' --points-at v1.1.0
```

Expected: `v1.1.0`, `v1.1` and `v1` all point at the same commit. If no new tag appeared, the workflow found no `feat`/`fix` commit — re-read the commit messages from Task 1 Step 7 against the action's `AGENTS.md`.

- [ ] **Step 4: Record the SHA for Task 3**

Note the full 40-character SHA from `git rev-parse v1.1.0`. Task 3 writes it verbatim.

---

### Task 3: This repository checks the version three ways and extracts the section

**Files:**
- Modify: `.github/workflows/release-and-publish.yaml` — insert a step after `- uses: actions/checkout@v6` (`:15`), and repoint the pin (`:19`)
- Test: `$SCRATCH/extract.sh` and `$SCRATCH/heading.sh` plus two fixtures, `SCRATCH=/tmp/claude-1000/-workspaces-wsqlite/28e03af0-53be-4c7b-adca-5a927eb11add/scratchpad` (throwaway)

**Interfaces:**
- Consumes: the action input `release-notes-file` from Task 1, and the SHA from Task 2.
- Produces: a step with `id: notes` whose output `file` is an absolute path under `$RUNNER_TEMP`.

- [ ] **Step 1: Write the failing extraction probe**

```bash
cat > "$SCRATCH/extract.sh" <<'EOF'
set -uo pipefail
VERSION="${GITHUB_REF_NAME#v}"

PKG=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
[ "$PKG" = "$VERSION" ] || { echo "ERR tag $GITHUB_REF_NAME != package.json ($PKG)"; exit 1; }

HEADING=$(awk -v ver="$VERSION" 'index($0, "## " ver " — ") == 1 { print; exit }' CHANGELOG.md)
[ -n "$HEADING" ] || { echo "ERR no CHANGELOG heading for $VERSION"; exit 1; }
case "$HEADING" in
  *" — "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "ERR heading not dated: $HEADING"; exit 1 ;;
esac

FILE="$RUNNER_TEMP/release-notes.md"
awk -v ver="$VERSION" '
  index($0, "## " ver " — ") == 1 { found=1; next }
  found && index($0, "## ") == 1  { exit }
  found                           { print }
' CHANGELOG.md > "$FILE"
grep -q '[^[:space:]]' "$FILE" || { echo "ERR section for $VERSION is empty"; exit 1; }
echo "OK $HEADING"
EOF
```

- [ ] **Step 2: Run it against the real file and two fixtures**

```bash
export RUNNER_TEMP="$SCRATCH"
printf '# Changelog\n\n## 2.0.0 — TBD\n\nUndated.\n\n## 1.5.0 — 2026-01-02\n\nLast section.\n' > "$SCRATCH/fixture.md"
printf '# Changelog\n\n## 3.0.0 — 2026-05-05\n\n## 2.9.0 — 2026-04-04\n\nx\n' > "$SCRATCH/blank.md"

GITHUB_REF_NAME=v1.0.0-rc.3 bash "$SCRATCH/extract.sh"     # OK
GITHUB_REF_NAME=v1.0.0-rc.4 bash "$SCRATCH/extract.sh"     # ERR, package.json is rc.3
GITHUB_REF_NAME=v9.9.9      bash "$SCRATCH/extract.sh"     # ERR, package.json
```

The version check stops the last two before the CHANGELOG is ever read, so the remaining branches need a second probe that takes the version and the file as arguments:

```bash
cat > "$SCRATCH/heading.sh" <<'EOF'
set -uo pipefail
VERSION="$1"; SRC="$2"
HEADING=$(awk -v ver="$VERSION" 'index($0, "## " ver " — ") == 1 { print; exit }' "$SRC")
[ -n "$HEADING" ] || { echo "  ERR no heading for $VERSION"; exit 1; }
case "$HEADING" in
  *" — "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
  *) echo "  ERR heading not dated: $HEADING"; exit 1 ;;
esac
awk -v ver="$VERSION" '
  index($0, "## " ver " — ") == 1 { found=1; next }
  found && index($0, "## ") == 1  { exit }
  found                           { print }
' "$SRC" > "$SCRATCH/out.md"
grep -q '[^[:space:]]' "$SCRATCH/out.md" || { echo "  ERR section is empty"; exit 1; }
echo "  OK ($(wc -l < "$SCRATCH/out.md") lines)"
EOF

bash "$SCRATCH/heading.sh" 1.0.0-rc.4 CHANGELOG.md
bash "$SCRATCH/heading.sh" 9.9.9      CHANGELOG.md
bash "$SCRATCH/heading.sh" 2.0.0      "$SCRATCH/fixture.md"
bash "$SCRATCH/heading.sh" 1.5.0      "$SCRATCH/fixture.md"
bash "$SCRATCH/heading.sh" 3.0.0      "$SCRATCH/blank.md"
```

Expected, in order:
```
  ERR no heading for 1.0.0-rc.4      # the file reads "## Unreleased — 1.0.0-rc.4"
  ERR no heading for 9.9.9
  ERR heading not dated: ## 2.0.0 — TBD
  OK (2 lines)                       # last section of the file
  ERR section is empty
```

`grep -q '[^[:space:]]'`, not `[ -s ]`: a section holding one blank line is one byte long, so `-s` calls it non-empty and the release ships blank. This was measured, not reasoned.

- [ ] **Step 3: Add the step to the workflow**

Insert immediately after `- uses: actions/checkout@v6` (`:15`):

```yaml
      # The release body is the CHANGELOG section for this tag. Nothing here
      # writes to CHANGELOG.md - the file is editorial, and CI only reads it.
      #
      # This runs before the action because it is the only place the tag, the
      # published version and the changelog are compared: the action publishes
      # the version it reads from package.json and validates the tag
      # separately, so nothing else checks that they agree.
      - name: Release notes from CHANGELOG.md 📝
        id: notes
        shell: bash
        run: |
          set -uo pipefail
          VERSION="${GITHUB_REF_NAME#v}"

          PKG=$(grep '"version"' package.json | head -1 | sed 's/.*"version": "\(.*\)".*/\1/')
          if [ "$PKG" != "$VERSION" ]; then
            echo "::error::tag $GITHUB_REF_NAME does not match package.json ($PKG)"
            exit 1
          fi

          HEADING=$(awk -v ver="$VERSION" 'index($0, "## " ver " — ") == 1 { print; exit }' CHANGELOG.md)
          if [ -z "$HEADING" ]; then
            echo "::error::no CHANGELOG.md heading for $VERSION"
            exit 1
          fi
          case "$HEADING" in
            *" — "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
            *) echo "::error::CHANGELOG.md heading for $VERSION is not dated: $HEADING"; exit 1 ;;
          esac

          FILE="$RUNNER_TEMP/release-notes.md"
          awk -v ver="$VERSION" '
            index($0, "## " ver " — ") == 1 { found=1; next }
            found && index($0, "## ") == 1  { exit }
            found                           { print }
          ' CHANGELOG.md > "$FILE"

          # Not [ -s ]: a section of one blank line is one byte and would pass.
          if ! grep -q '[^[:space:]]' "$FILE"; then
            echo "::error::CHANGELOG.md section for $VERSION is empty"
            exit 1
          fi

          echo "file=$FILE" >> "$GITHUB_OUTPUT"
          echo "Release body: $HEADING ($(wc -l < "$FILE") lines)"
```

- [ ] **Step 4: Repoint the pin and pass the input**

Replace `:19-22` with the SHA from Task 2 Step 4:

```yaml
      - uses: lalexdotcom/action-release-and-publish@<SHA-FROM-TASK-2> # v1.1.0
        with:
          npm-token: ${{ secrets.NPM_TOKEN }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          release-notes-file: ${{ steps.notes.outputs.file }}
```

Keep the comment above the `uses:` line explaining why it is a SHA and not `v1` — it is still true and still load-bearing.

- [ ] **Step 5: Check the YAML parses**

```bash
node -e "const y=require('yaml');const f=require('fs').readFileSync('.github/workflows/release-and-publish.yaml','utf8');const d=y.parse(f);console.log(d.jobs.release.steps.map(s=>s.name??s.uses))"
```

Expected: three entries — `actions/checkout@v6`, `Release notes from CHANGELOG.md 📝`, and the pinned action. If `yaml` is not resolvable, `npx --yes yaml` or any parser will do; the point is that the file parses and the steps are in that order.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/release-and-publish.yaml
git commit -m "ci: the release body is the CHANGELOG section for the tag

A step between checkout and the action asserts that the tag, package.json
and a dated CHANGELOG heading all name the same version, extracts that
section into RUNNER_TEMP and passes the path to the action's new
release-notes-file input.

It sits before the action because it is the only place those three are
compared - the action publishes the version it reads from package.json and
validates the tag separately, and nothing checked that they agree once
upversion stopped being used here.

Emptiness is tested with grep, not [ -s ]: a section of one blank line is
one byte and would have shipped a release with a blank body."
```

---

### Task 4: Record what cannot be re-derived, and close the branch

**Files:**
- Modify: `.serena/memories/conventions.md`

- [ ] **Step 1: Add the release procedure to `mem:conventions`**

Under a new `## Releasing` heading, after the `## Git and versioning` section:

```markdown
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

Design: `docs/superpowers/specs/2026-08-31-release-notes-from-changelog-design.md`.
```

- [ ] **Step 2: Verify the closure conditions**

```bash
npx tsc --noEmit && echo TSC CLEAN
pnpm check 2>&1 | tail -3
pnpm test 2>&1 | grep -E '"status"|"failedFiles"|"tests":|"failedTests"'
git status --short
```

Expected: tsc clean, biome 13 warnings, `status: pass` with 470 tests and 0 `failedFiles`, clean tree. Nothing in this plan touches `src/`, so any deviation from that baseline is unrelated to this work and must be reported, not absorbed.

- [ ] **Step 3: Commit the memory**

```bash
git add .serena/memories/conventions.md
git commit -m "docs(memory): how a release is cut, and why it takes two repositories"
```

- [ ] **Step 4: Merge and sweep**

`git merge -F -` does not read stdin — write the body to a file first.

```bash
cat > "$SCRATCH/merge-msg.txt" <<'MSG'
Merge branch 'feat/release-notes-from-changelog'

A tag pushed here now produces a GitHub Release whose body is the matching
CHANGELOG.md section, and npm is no longer published before that release
exists.

The work spans two repositories and could not be one commit: the action
releases itself on push and we consume it by SHA, so its change had to ship
before the pin here could move.

No automation writes to CHANGELOG.md. The workflow reads it; the action
receives a path and never learns where it came from.
MSG

git checkout main
git merge --no-ff feat/release-notes-from-changelog -F "$SCRATCH/merge-msg.txt"
git merge-base --is-ancestor feat/release-notes-from-changelog main && git branch -D feat/release-notes-from-changelog
git branch -a
```

Pushing stays the user's call.

---

## End-to-end verification, gated on the user

Nothing in this plan proves itself until a tag is pushed. The first real proof is the rc.4 release, and cutting it is the user's decision, not this plan's:

1. Date `## Unreleased — 1.0.0-rc.4` to `## 1.0.0-rc.4 — <date>`; open no new section.
2. Set `package.json` to `1.0.0-rc.4` in the same commit.
3. Tag `v1.0.0-rc.4`, and let the user push it.
4. The release page must show the CHANGELOG section followed by the `Full Changelog` link, and the npm publish must appear in the job log **after** the release step.
