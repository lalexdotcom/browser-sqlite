---
quick_id: 260324-rxw
description: "Supprimer les traces 'window is not defined' dans les tests browser"
mode: quick
tasks:
  - id: T1
    files: [rstest.config.ts]
    action: "Ajouter dev.browserLogs: false dans pluginCrossOriginIsolation"
    verify: "pnpm test — 0 erreur [browser], 82/82 passent"
    done: true
---

# Quick Plan 260324-rxw

## Task T1: Désactiver browserLogs dans la config rsbuild

**Root cause identifiée :** le client HMR de rsbuild (hmr.js) est injecté dans le bundle worker par rspack. Après chaque build, rsbuild envoie un message WebSocket 'ok' → le client HMR appelle `reloadPage()` → `window.location.reload()` sans guard `typeof window` → ReferenceError dans le contexte Worker.

**Fix :** `dev.browserLogs: false` dans `mergeRsbuildConfig`. Cela supprime le forwarding des erreurs browser au terminal. Les échecs de tests restent rapportés par le mécanisme propre de rstest.
