---
quick_id: 260324-rxw
description: "Supprimer les traces 'window is not defined' dans les tests browser"
date: 2026-03-24
commit: fa1a813
status: complete
---

# Quick Task 260324-rxw — Summary

## What was done

**Root cause:** Le client HMR de rsbuild (`hmr.js`) est injecté dans le bundle Web Worker par rspack. Après chaque build réussi, rsbuild envoie un message WebSocket 'ok' → le client HMR dans le worker appelle `handleSuccess()` → `tryApplyUpdates()` → `reloadPage()` → `window.location.reload()`. La fonction `reloadPage()` n'a pas de guard `typeof window`, ce qui provoque un `ReferenceError` dans le contexte Worker (qui n'a que `self`, pas `window`). L'erreur est forwardée au serveur rsbuild via WebSocket et loggée avec le préfixe `[browser]`.

**Tentative 1 — `dev.liveReload: false`:** supprime les erreurs ✓ mais bloque le démarrage des tests. rstest utilise le live reload pour déclencher le chargement initial du test runner dans le browser. ✗

**Tentative 2 — `dev.hmr: false`:** supprime les erreurs ✓ mais bloque les tests (60s timeout). Le canal WebSocket utilisé par rstest pour coordonner l'exécution des tests est désactivé. ✗

**Fix retenu — `dev.browserLogs: false`:** désactive uniquement le forwarding des erreurs browser au terminal. Les erreurs `window is not defined` continuent de se produire dans le worker mais ne sont plus loggées. Les échecs de tests restent rapportés par le mécanisme propre de rstest (indépendant de `browserLogs`). ✓

## Changes

### `rstest.config.ts`
- Ajouté `dev: { browserLogs: false }` dans le `mergeRsbuildConfig` du `pluginCrossOriginIsolation`

## Verification

- `pnpm test:browser` : 25/25 passent, 0 traces `[browser] Uncaught ReferenceError`
- `pnpm test` (unit + browser) : 82/82 passent, stdout ET stderr propres
- `pnpm tsc --noEmit` : exit 0, aucune erreur
