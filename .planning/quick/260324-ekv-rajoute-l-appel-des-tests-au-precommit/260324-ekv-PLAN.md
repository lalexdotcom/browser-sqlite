---
phase: quick
plan: 260324-ekv
type: execute
wave: 1
depends_on: []
files_modified:
  - .simple-git-hooks.json
autonomous: true
requirements: []

must_haves:
  truths:
    - "Le hook pre-commit exécute les tests avant d'accepter le commit"
    - "Un échec des tests bloque le commit"
    - "Le lint/format existant reste fonctionnel"
  artifacts:
    - path: ".simple-git-hooks.json"
      provides: "Configuration du hook pre-commit avec lint-staged + tests"
      contains: "rstest"
  key_links:
    - from: ".simple-git-hooks.json"
      to: "pnpm test (rstest)"
      via: "commande dans pre-commit"
      pattern: "rstest|pnpm test"
---

<objective>
Ajouter l'exécution des tests unitaires (rstest) dans le hook pre-commit, après le lint/format existant (lint-staged).

Purpose: Garantir qu'aucun commit ne casse les tests existants.
Output: `.simple-git-hooks.json` mis à jour — le hook exécute `npx lint-staged && pnpm test` à chaque commit.
</objective>

<execution_context>
@/workspaces/wsqlite/.claude/get-shit-done/workflows/execute-plan.md
@/workspaces/wsqlite/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<!-- Contexte du hook existant -->
<!-- .simple-git-hooks.json actuel : { "pre-commit": "npx lint-staged" } -->
<!-- package.json "test": "rstest" — lancé via `pnpm test` -->
<!-- lint-staged config dans package.json couvre *.{js,ts,jsx,tsx,mjs,cjs} avec biome check -->
</context>

<tasks>

<task type="auto">
  <name>Task 1: Ajouter les tests au hook pre-commit</name>
  <files>.simple-git-hooks.json</files>
  <action>
    Modifier `.simple-git-hooks.json` pour enchaîner lint-staged et les tests :

    ```json
    {
      "pre-commit": "npx lint-staged && pnpm test"
    }
    ```

    `lint-staged` s'exécute en premier (format + lint sur les fichiers stagés).
    Si lint-staged réussit, `pnpm test` lance la suite complète via rstest.
    Si l'un ou l'autre échoue, le commit est bloqué.

    Note : les tests s'exécutent sur toute la suite (pas seulement les fichiers stagés) — comportement attendu pour détecter les régressions.

    Après modification du fichier, réinstaller le hook pour que le changement prenne effet :
    ```bash
    pnpm simple-git-hooks
    ```

    Vérifier que `.git/hooks/pre-commit` contient bien la nouvelle commande.
  </action>
  <verify>
    <automated>grep -q "pnpm test" /workspaces/wsqlite/.simple-git-hooks.json && grep -q "lint-staged" /workspaces/wsqlite/.simple-git-hooks.json && grep -q "pnpm test" /workspaces/wsqlite/.git/hooks/pre-commit && echo "OK"</automated>
  </verify>
  <done>
    - `.simple-git-hooks.json` contient `npx lint-staged && pnpm test`
    - `.git/hooks/pre-commit` reflète la nouvelle commande
    - `pnpm test` seul passe (la suite de tests est verte)
  </done>
</task>

</tasks>

<verification>
- `.simple-git-hooks.json` contient `npx lint-staged && pnpm test`
- `.git/hooks/pre-commit` est exécutable et contient la commande mise à jour
- `pnpm test` se termine avec exit code 0
- Un commit de test déclenche bien lint-staged puis rstest
</verification>

<success_criteria>
Le hook pre-commit bloque tout commit dont les tests unitaires échouent, tout en conservant le lint/format Biome existant.
</success_criteria>

<output>
After completion, create `.planning/quick/260324-ekv-rajoute-l-appel-des-tests-au-precommit/260324-ekv-SUMMARY.md`
</output>
