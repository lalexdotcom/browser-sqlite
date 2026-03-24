---
quick_id: 260324-sj3
description: "Limiter biome à src et tests"
status: completed
---

# Quick Task 260324-sj3: Limiter biome à src et tests

## Changes

- Added `files.includes: ["src/**", "tests/**"]` to `biome.json` to restrict linting/formatting scope
- This prevents biome from scanning `.claude/`, `.planning/`, and other non-source directories

## Files Modified

- `biome.json`
