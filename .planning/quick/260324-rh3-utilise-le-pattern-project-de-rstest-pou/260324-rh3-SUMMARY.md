---
quick_id: 260324-rh3
one_liner: "Unified rstest.config.ts with projects array (unit + browser) — rstest.browser.config.ts deleted"
tags: [rstest, config, testing, projects]
key_files:
  modified:
    - rstest.config.ts
    - package.json
  deleted:
    - rstest.browser.config.ts
decisions:
  - "projects array at root level with extends: withRslibConfig() at root — not per project"
  - "pluginCrossOriginIsolation moved into rstest.config.ts at top, before export default"
metrics:
  duration: "2min"
  tasks_completed: 2
  files_changed: 2
  files_deleted: 1
  completed_date: "2026-03-24"
---

# Quick Task 260324-rh3: Unified rstest config with projects pattern

## What Was Done

Merged `rstest.config.ts` (unit/Node tests) and `rstest.browser.config.ts` (Playwright/Chromium browser tests) into a single unified config file using the rstest `projects` array pattern.

## Changes

### rstest.config.ts (rewritten)

- `pluginCrossOriginIsolation` plugin definition moved from `rstest.browser.config.ts` into this file (top of file, before `export default`)
- `extends: withRslibConfig()` kept at root level (applies to all projects)
- `projects` array added with two entries:
  - `unit`: includes `tests/**/*.test.ts`, excludes `tests/browser/**`, `passWithNoTests: true`
  - `browser`: Playwright/Chromium, `pluginCrossOriginIsolation` plugin, includes `tests/browser/**/*.test.ts`, `testTimeout: 30000`

### rstest.browser.config.ts (deleted)

File removed — all its configuration is now in `rstest.config.ts`.

### package.json

`test:browser` script updated:
- Before: `rstest --config rstest.browser.config.ts`
- After: `rstest --project browser`

## Verification

- `rstest.config.ts` contains `projects` array with `unit` and `browser` entries
- `rstest.browser.config.ts` no longer exists
- `pnpm test` passes: 82 tests, 0 failures across 6 test files (both unit and browser suites)
- `package.json` `test:browser` points to `rstest --project browser`
- `pluginCrossOriginIsolation` present in `rstest.config.ts`

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 43076bf | feat(260324-rh3): merge rstest configs using projects pattern |
| 2 | 5d57edc | chore(260324-rh3): update test:browser script to use --project browser |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `rstest.config.ts` exists and contains `projects` and `pluginCrossOriginIsolation`
- `rstest.browser.config.ts` deleted
- Both commits exist (43076bf, 5d57edc)
- `pnpm test` passes with 82 tests
