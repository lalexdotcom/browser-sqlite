---
phase: quick
plan: 260324-rkh
type: execute
wave: 1
depends_on: []
files_modified:
  - rstest.config.ts
  - rslib.config.ts
  - package.json
autonomous: true
requirements: []

must_haves:
  truths:
    - "pnpm build produit uniquement dist/esm/ (pas dist/cjs/, pas dist/umd/)"
    - "pnpm test passe sans erreur"
    - "Aucune erreur TypeScript dans rstest.config.ts (plus de type `Function`)"
    - "package.json ne référence que dist/esm/ et ne déclare pas @rsbuild/plugin-node-polyfill"
  artifacts:
    - path: "rstest.config.ts"
      provides: "Config rstest sans erreur de type"
    - path: "rslib.config.ts"
      provides: "Build ESM-only"
    - path: "package.json"
      provides: "Entrées exports cohérentes avec ESM-only"
  key_links:
    - from: "rslib.config.ts"
      to: "dist/esm/"
      via: "format: 'esm'"
    - from: "package.json exports"
      to: "dist/esm/index.js"
      via: "import et default"
---

<objective>
Corriger l'erreur de type `Function` dans rstest.config.ts, simplifier rslib.config.ts en ESM-only, et aligner package.json avec les sorties réelles.

Purpose: La lib est browser-only. Les formats CJS et UMD sont inutiles et créent une confusion (les entrées package.json pointent vers des fichiers CJS qui n'existent pas si on supprime le format). L'erreur de type `Function` (interdit en strict TypeScript) génère des avertissements IDE et échouera si biome lint strict est activé.
Output: rstest.config.ts sans `Function`, build ESM-only, package.json cohérent.
</objective>

<execution_context>
@/workspaces/wsqlite/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@/workspaces/wsqlite/rstest.config.ts
@/workspaces/wsqlite/rslib.config.ts
@/workspaces/wsqlite/package.json
@/workspaces/wsqlite/tsconfig.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Corriger le type `Function` dans rstest.config.ts</name>
  <files>rstest.config.ts</files>
  <action>
Remplacer les deux occurrences du type `Function` (lignes 9 et 13) par des signatures précises.

Le plugin Rsbuild a cette forme générale — utiliser `unknown` pour les parties non typées plutôt que `Function` :

```typescript
const pluginCrossOriginIsolation = {
  name: 'rsbuild:cross-origin-isolation',
  setup(api: {
    modifyRsbuildConfig: (
      fn: (
        config: Record<string, unknown>,
        utils: { mergeRsbuildConfig: (...configs: Record<string, unknown>[]) => Record<string, unknown> }
      ) => Record<string, unknown>
    ) => void
  }) {
    api.modifyRsbuildConfig(
      (
        config: Record<string, unknown>,
        { mergeRsbuildConfig }: { mergeRsbuildConfig: (...configs: Record<string, unknown>[]) => Record<string, unknown> },
      ) =>
        mergeRsbuildConfig(config, {
          server: {
            headers: {
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
            },
          },
        }),
    );
  },
};
```

Si les types Rsbuild réels sont disponibles via `@rsbuild/core`, importer `RsbuildConfig` et `mergeRsbuildConfig` pour être plus précis. Sinon, la signature avec `Record<string, unknown>` est acceptable et supprime l'erreur `Function`.

Vérifier avec `pnpm exec tsc --noEmit --skipLibCheck` APRÈS avoir étendu tsconfig.json pour inclure les fichiers de config (voir note ci-dessous).

NOTE sur tsconfig.json : actuellement `"include": ["src"]` — les fichiers de config (rstest.config.ts, rslib.config.ts) sont hors du scope tsc, donc les erreurs ne sont détectées que par le language server. Pour les attraper aussi avec tsc, ajouter les fichiers de config à l'include :
```json
"include": ["src", "rslib.config.ts", "rstest.config.ts"]
```
Appliquer cette modification à tsconfig.json également dans cette tâche.
  </action>
  <verify>
    <automated>cd /workspaces/wsqlite && pnpm exec tsc --noEmit 2>&1 | grep -E "Function|error TS" || echo "OK — aucune erreur tsc"</automated>
  </verify>
  <done>Aucune occurrence de `Function` comme type dans rstest.config.ts. tsc --noEmit passe sans erreur sur les fichiers de config.</done>
</task>

<task type="auto">
  <name>Task 2: Simplifier rslib.config.ts en ESM-only et aligner package.json</name>
  <files>rslib.config.ts, package.json</files>
  <action>
**rslib.config.ts** — Supprimer les entrées `cjs` et `umd`, garder uniquement `esm` :

```typescript
import { defineConfig } from '@rslib/core';

export default defineConfig({
  lib: [
    {
      format: 'esm',
      syntax: 'esnext',
      dts: true,
      output: {
        distPath: './dist/esm',
      },
    },
  ],
});
```

**package.json** — Mettre à jour pour ne référencer que dist/esm/ :

1. Supprimer `"main": "./dist/cjs/index.cjs"` — obsolète (CJS supprimé)
2. Supprimer `"unpkg"` et `"jsdelivr"` — UMD supprimé, CDN sans COOP/COEP ne peut pas charger la lib de toute façon
3. Mettre à jour `"exports"` :
   ```json
   "exports": {
     ".": {
       "types": "./dist/esm/index.d.ts",
       "import": "./dist/esm/index.js",
       "default": "./dist/esm/index.js"
     }
   }
   ```
4. Supprimer l'entrée `"require"` des exports (CJS supprimé)
5. Supprimer `@rsbuild/plugin-node-polyfill` de `devDependencies` — inutilisé depuis la tâche précédente 260324-o2g

Supprimer aussi `dist/cjs/` et `dist/umd/` du répertoire dist si présents :
```bash
rm -rf /workspaces/wsqlite/dist/cjs /workspaces/wsqlite/dist/umd
```
  </action>
  <verify>
    <automated>cd /workspaces/wsqlite && pnpm build 2>&1 && ls dist/ && echo "dist/esm présent:" && ls dist/esm/ | head -5</automated>
  </verify>
  <done>pnpm build réussit. dist/ contient uniquement esm/. package.json ne contient plus main, unpkg, jsdelivr, require, ni @rsbuild/plugin-node-polyfill. exports pointe vers dist/esm/.</done>
</task>

<task type="auto">
  <name>Task 3: Vérification finale (build + tests)</name>
  <files></files>
  <action>
Lancer la suite de vérifications dans l'ordre :

1. `pnpm exec tsc --noEmit` — aucune erreur de type
2. `pnpm build` — doit réussir, uniquement dist/esm/
3. `pnpm test` — tous les tests passent

Si pnpm test échoue à cause d'un import résiduel vers dist/cjs, vérifier rstest.config.ts et s'assurer que withRslibConfig() pointe vers la bonne sortie. Normalement la config rstest s'appuie sur rslib.config.ts qui a été simplifié.

Si biome lint détecte des problèmes dans les fichiers modifiés, les corriger avant de committer.
  </action>
  <verify>
    <automated>cd /workspaces/wsqlite && pnpm exec tsc --noEmit && pnpm build && pnpm test 2>&1 | tail -20</automated>
  </verify>
  <done>tsc --noEmit, pnpm build et pnpm test passent tous sans erreur.</done>
</task>

</tasks>

<verification>
- `pnpm exec tsc --noEmit` : 0 erreur
- `pnpm build` : produit dist/esm/ uniquement
- `pnpm test` : tous les tests verts
- `grep -n "Function" rstest.config.ts` : 0 résultat
- `grep -E "cjs|umd|unpkg|jsdelivr|plugin-node-polyfill" package.json` : 0 résultat
</verification>

<success_criteria>
- Aucun type `Function` dans les fichiers de config
- tsconfig.json inclut rslib.config.ts et rstest.config.ts dans le scope tsc
- rslib.config.ts : 1 seul format (esm)
- package.json : exports, types, et files cohérents avec ESM-only
- @rsbuild/plugin-node-polyfill absent de devDependencies
- pnpm build et pnpm test passent
</success_criteria>

<output>
Après complétion, mettre à jour .planning/STATE.md section "Quick Tasks Completed" avec :
| 260324-rkh | Corriger type Function rstest.config, ESM-only rslib, aligner package.json | 2026-03-24 | {commit} | 260324-rkh-corriger-erreur-de-type-dans-rslib-confi |
</output>
