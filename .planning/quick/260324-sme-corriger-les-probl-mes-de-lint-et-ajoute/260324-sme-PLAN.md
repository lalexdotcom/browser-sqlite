---
quick_id: 260324-sme
description: "Corriger les problèmes de lint et ajouter script lint"
tasks: 3
---

# Quick Plan: Corriger les problèmes de lint et ajouter script lint

## Task 1: Désactiver noExplicitAny et noBannedTypes dans biome.json
- **files**: `biome.json`
- **action**: Désactiver les règles non pertinentes pour ce projet (any légitime pour SQL params, opaque wa-sqlite handles)

## Task 2: Corriger noAssignInExpressions dans utils.ts
- **files**: `src/utils.ts`
- **action**: Séparer l'assignation de l'appel à set()

## Task 3: Ajouter script lint dans package.json
- **files**: `package.json`
- **action**: Ajouter `"lint": "biome lint"` aux scripts
