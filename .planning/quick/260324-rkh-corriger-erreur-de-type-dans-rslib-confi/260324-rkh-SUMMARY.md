---
phase: quick
plan: 260324-rkh
subsystem: build-config
tags: [typescript, rslib, rstest, esm, package-json]
key-files:
  modified:
    - rstest.config.ts
    - rslib.config.ts
    - tsconfig.json
    - package.json
decisions:
  - "Tasks 1 et 2 commitées ensemble : le pre-commit hook exécute tsc --noEmit qui échoue tant que rslib.config.ts contient umdModuleName (propriété invalide dans les types @rslib/core actuels)"
metrics:
  duration: ~2min
  completed: "2026-03-24"
  tasks_completed: 3
  files_modified: 4
---

# Quick Task 260324-rkh: Corriger type Function rstest.config, ESM-only rslib, aligner package.json

**One-liner:** Signatures TypeScript précises pour le plugin COOP/COEP, build ESM-only, package.json aligné sur dist/esm/.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1+2 | Corriger type Function + ESM-only + package.json | aae4cc9 | rstest.config.ts, tsconfig.json, rslib.config.ts, package.json |
| 3 | Vérification finale | — (vérification pure, pas de commit) | — |

## Changes Made

### rstest.config.ts

Remplacement des deux occurrences du type `Function` (interdit en TypeScript strict) par des signatures précises :
- `modifyRsbuildConfig` : paramètre de type `(fn: (config: Record<string, unknown>, utils: {...}) => Record<string, unknown>) => void`
- `mergeRsbuildConfig` : signature `(...configs: Record<string, unknown>[]) => Record<string, unknown>`

### tsconfig.json

Ajout de `rslib.config.ts` et `rstest.config.ts` dans le champ `include` pour que `tsc --noEmit` vérifie aussi les fichiers de configuration (précédemment hors scope).

### rslib.config.ts

Suppression des formats `cjs` et `umd`. Conserve uniquement le format `esm` avec `distPath: './dist/esm'`. La lib est browser-only et les formats CJS/UMD étaient inutilisés et invalides en termes de types (@rslib/core ne connaît plus `umdModuleName`).

### package.json

- `exports` : suppression de `require` et de la référence à `dist/cjs/index.d.ts`, types pointent maintenant vers `dist/esm/index.d.ts`
- Suppression de `"main": "./dist/cjs/index.cjs"`
- Suppression de `"unpkg"` et `"jsdelivr"` (UMD supprimé, CDN incompatible avec COOP/COEP)
- Suppression de `@rsbuild/plugin-node-polyfill` de `devDependencies`

## Verification Results

- `pnpm exec tsc --noEmit` : 0 erreur
- `pnpm build` : dist/ contient uniquement `esm/` (dist/esm/index.js 16.9 kB)
- `pnpm test` : 83 tests passent (via pre-commit hook)
- `grep "Function" rstest.config.ts` : 0 résultat (hors commentaires)
- `grep -E "cjs|umd|unpkg|jsdelivr|plugin-node-polyfill" package.json` : 0 résultat (hors extension lint-staged `*.cjs`)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Tasks 1 et 2 fusionnées en un seul commit**

- **Found during:** Task 1 commit attempt
- **Issue:** Le pre-commit hook exécute `tsc --noEmit`. Une fois tsconfig.json étendu pour inclure rslib.config.ts, l'erreur `umdModuleName does not exist in type 'LibConfig'` (existante dans rslib.config.ts) bloquait le commit de task 1.
- **Fix:** Application des changements rslib.config.ts et package.json (task 2) avant le premier commit, puis commit unique couvrant les deux tâches.
- **Files modified:** rslib.config.ts, package.json
- **Commit:** aae4cc9

## Self-Check: PASSED

- rstest.config.ts : existe, aucun type `Function`
- rslib.config.ts : existe, format esm uniquement
- tsconfig.json : existe, include contient les fichiers de config
- package.json : existe, pas de cjs/umd/unpkg/jsdelivr/@rsbuild/plugin-node-polyfill
- Commit aae4cc9 : present in git log
