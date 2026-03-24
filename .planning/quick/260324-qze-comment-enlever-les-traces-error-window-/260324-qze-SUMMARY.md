---
quick_id: 260324-qze
description: "Supprimer les erreurs window is not defined dans les tests browser"
date: 2026-03-24
commit: 7616dfa
status: complete
---

# Quick Task 260324-qze — Summary

## What was done

**Root cause:** `pluginNodePolyfill()` dans `rslib.config.ts` injectait des polyfills Node.js (`util`, `process`, `buffer`) dans le bundle du Web Worker. Ces polyfills référencent `window` directement, ce qui provoque un `ReferenceError` dans le contexte Worker (qui n'a que `self`, pas `window`). Ce plugin avait été ajouté pour `@lalex/console` (son module `util` accédait à `process.env.NODE_DEBUG`). `@lalex/console` ayant été supprimé, le plugin n'est plus nécessaire.

## Changes

### `rslib.config.ts` — nettoyé
- Supprimé `import { pluginNodePolyfill }` et son appel
- Supprimé `pluginCrossOriginIsolation` (COOP/COEP headers + define `process.env.NODE_DEBUG`)
- Supprimé `tools.rspack.ignoreWarnings` (warnings `import.meta` de @lalex/console)
- Résultat : fichier réduit à la pure configuration `lib` (esm/cjs/umd)

### `rstest.browser.config.ts` — amélioré
- COOP/COEP headers déplacés ici (depuis rslib.config.ts) comme plugin inline
- Ajouté `exclude: ['**/worktrees/**']` pour éviter que les worktrees GSD soient scannés
- Le plugin `pluginCrossOriginIsolation` est maintenant co-localisé avec la config browser

## Verification

- `pnpm test` : 57/57 passent, 0 échecs
- `rslib.config.ts` : ne contient plus de références à `window`, `pluginNodePolyfill`, ou `@lalex/console`
