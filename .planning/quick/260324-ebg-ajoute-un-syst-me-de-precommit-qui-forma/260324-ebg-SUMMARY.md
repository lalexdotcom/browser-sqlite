---
phase: quick
plan: 260324-ebg
subsystem: tooling
tags: [pre-commit, lint, format, biome, git-hooks]
dependency_graph:
  requires: []
  provides: [pre-commit-hook]
  affects: [developer-workflow]
tech_stack:
  added: [simple-git-hooks@2.13.1, lint-staged@16.4.0]
  patterns: [git hooks via simple-git-hooks, staged-file linting via lint-staged]
key_files:
  created:
    - .simple-git-hooks.json
  modified:
    - package.json
    - pnpm-lock.yaml
decisions:
  - Use pnpm.onlyBuiltDependencies to allow simple-git-hooks postinstall in pnpm security model
  - Use biome check --write with --no-errors-on-unmatched for combined format+lint+organize-imports
metrics:
  duration: "~5 minutes"
  completed: "2026-03-24T10:21:18Z"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 3
---

# Quick Task 260324-ebg: Pre-commit Hook with Biome Summary

**One-liner:** Pre-commit hook using simple-git-hooks + lint-staged to run `biome check --write` on staged JS/TS files before every commit.

## What Was Done

Configured a pre-commit system that automatically formats and lints staged TypeScript/JavaScript files before each commit, using Biome (already present in the project) via simple-git-hooks + lint-staged.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | Install simple-git-hooks + lint-staged, configure pre-commit hook | a42195c |

## Changes Made

### `.simple-git-hooks.json` (created)

Defines the pre-commit hook pointing to `npx lint-staged`.

### `package.json` (modified)

- Added `simple-git-hooks@^2.13.1` and `lint-staged@^16.4.0` to `devDependencies`
- Added `prepare` script: `simple-git-hooks` — ensures hooks are (re)installed after `pnpm install`
- Added `lint-staged` config: runs `biome check --write --no-errors-on-unmatched` on `*.{js,ts,jsx,tsx,mjs,cjs}` files
- Added `pnpm.onlyBuiltDependencies: ["simple-git-hooks"]` to allow its postinstall script

## Verification

- `.git/hooks/pre-commit` exists and is executable
- Hook content calls `npx lint-staged`
- `simple-git-hooks` and `lint-staged` present in `devDependencies`
- `prepare` script present in `package.json`
- `lint-staged` section present in `package.json`
- Hook was invoked during the task commit itself (ran lint-staged, found no matching staged files — expected since only config files were staged, not JS/TS)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing config] Added pnpm.onlyBuiltDependencies for simple-git-hooks**

- **Found during:** Task 1
- **Issue:** pnpm blocks postinstall scripts by default for security. `simple-git-hooks` needs its postinstall to register hooks, and `pnpm approve-builds` requires interactive input unavailable in automation.
- **Fix:** Added `pnpm.onlyBuiltDependencies: ["simple-git-hooks"]` to `package.json` and re-ran `pnpm install`. The postinstall ran successfully.
- **Files modified:** `package.json`
- **Commit:** a42195c

## Known Stubs

None.

## Self-Check: PASSED

- `.simple-git-hooks.json`: EXISTS
- `package.json` updated with lint-staged config and prepare script: VERIFIED
- `.git/hooks/pre-commit` executable: EXISTS
- Commit a42195c: EXISTS
