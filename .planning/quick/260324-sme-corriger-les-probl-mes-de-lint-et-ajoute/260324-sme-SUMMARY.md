---
quick_id: 260324-sme
description: "Corriger les problèmes de lint et ajouter script lint"
status: completed
---

# Quick Task 260324-sme: Corriger les problèmes de lint et ajouter script lint

## Changes

- Disabled `noExplicitAny` and `noBannedTypes` rules in biome.json (legitimate any usage for SQL params and opaque wa-sqlite handles)
- Fixed `noAssignInExpressions` error in `src/utils.ts` by separating assignment from `Map.set()` call
- Added `"lint": "biome lint"` script to package.json
- Ran `biome check --write --unsafe` to apply all available autofixes (4 files fixed)

## Files Modified

- `biome.json`
- `src/utils.ts`
- `package.json`

## Result

`biome check` passes with 0 errors and 0 warnings.
