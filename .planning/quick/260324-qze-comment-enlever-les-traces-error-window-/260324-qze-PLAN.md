---
quick_task: 260324-qze
type: execute
autonomous: true
files_modified:
  - rslib.config.ts
---

<objective>
Supprimer les résidus de @lalex/console dans rslib.config.ts pour éliminer les erreurs
"Uncaught ReferenceError: window is not defined" dans les tests browser.

Purpose: pluginNodePolyfill() injecte des polyfills Node.js (process, buffer, util…) qui
référencent `window` au chargement. Le Web Worker (src/worker.ts) ne dispose pas de `window`,
ce qui provoque un ReferenceError. Ces polyfills n'ont jamais été utiles qu'à @lalex/console
(son dépendance `util`), qui a été retiré. Sans pluginNodePolyfill le bundle worker ne contiendra
plus ces polyfills.

Output: rslib.config.ts minimal, sans plugins ni workarounds liés à @lalex/console.
</objective>

<context>
@/workspaces/wsqlite/rslib.config.ts
@/workspaces/wsqlite/rstest.browser.config.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Nettoyer rslib.config.ts — supprimer pluginNodePolyfill et pluginCrossOriginIsolation</name>
  <files>rslib.config.ts</files>
  <action>
Réécrire rslib.config.ts pour ne conserver que la configuration de build essentielle.

Supprimer intégralement :
- L'import `pluginNodePolyfill` (ligne 1)
- Le plugin inline `pluginCrossOriginIsolation` (lignes 7–48) avec ses deux blocs :
  - `modifyRsbuildConfig` (COOP/COEP headers) — déjà couverts par rstest.browser.config.ts server.headers
  - `modifyEnvironmentConfig` (define `process.env.NODE_DEBUG: 'undefined'`) — workaround pour le polyfill `util` de @lalex/console
- L'appel `plugins: [pluginNodePolyfill(), pluginCrossOriginIsolation()]` dans defineConfig

Supprimer également :
- La section `tools.rspack.ignoreWarnings` sur `import.meta` — était là pour les chemins morts de @lalex/console

Le fichier final doit être :

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
    {
      format: 'cjs',
      syntax: 'es2015',
      dts: true,
      output: {
        distPath: './dist/cjs',
      },
    },
    {
      format: 'umd',
      syntax: 'es2015',
      dts: false,
      umdModuleName: 'wsqlite',
      output: {
        distPath: './dist/umd',
      },
    },
  ],
});
```

Ne pas supprimer `@rsbuild/plugin-node-polyfill` de package.json (hors scope — devDep inutilisée
ne casse rien et le nettoyage des dépendances est une opération séparée).
  </action>
  <verify>
    <automated>cd /workspaces/wsqlite && pnpm test:browser 2>&1 | grep -E "window is not defined|ReferenceError|PASS|FAIL|Tests" | head -30</automated>
  </verify>
  <done>
- rslib.config.ts ne contient plus aucune référence à pluginNodePolyfill, pluginCrossOriginIsolation, process.env.NODE_DEBUG, ignoreWarnings
- pnpm test:browser passe sans erreur "window is not defined" ni ReferenceError
- pnpm build réussit (les trois formats esm/cjs/umd sont produits)
  </done>
</task>

</tasks>

<verification>
Après la tâche :
1. `pnpm test:browser` — aucune trace de "window is not defined" ou "ReferenceError"
2. `pnpm build` — les trois formats dist/esm, dist/cjs, dist/umd sont générés sans erreur
3. `grep -n "pluginNodePolyfill\|pluginCrossOriginIsolation\|NODE_DEBUG\|ignoreWarnings" rslib.config.ts` — aucun résultat
</verification>

<success_criteria>
Les tests browser s'exécutent sans ReferenceError liée à `window`. rslib.config.ts est réduit à
la configuration de lib (3 formats), sans aucun plugin ni workaround hérité de @lalex/console.
</success_criteria>

<output>
Après completion, mettre à jour .planning/STATE.md section "Quick Tasks Completed" avec :
| 260324-qze | Supprimer pluginNodePolyfill et résidus @lalex/console de rslib.config.ts | 2026-03-24 | [commit] | [260324-qze-comment-enlever-les-traces-error-window-] |
</output>
