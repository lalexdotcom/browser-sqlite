---
phase: quick
plan: 260324-epa
type: execute
wave: 1
depends_on: []
files_modified:
  - .simple-git-hooks.json
autonomous: true
requirements: []

must_haves:
  truths:
    - "Le hook pre-commit vérifie les types TypeScript avant d'accepter le commit"
    - "Le hook pre-commit vérifie que le projet build avant d'accepter le commit"
    - "Un échec de vérification de types bloque le commit"
    - "Un échec du build bloque le commit"
    - "Le lint/format et les tests existants restent fonctionnels"
  artifacts:
    - path: ".simple-git-hooks.json"
      provides: "Configuration du hook pre-commit avec lint-staged + tests + typecheck + build"
      contains: "tsc"
  key_links:
    - from: ".simple-git-hooks.json"
      to: "tsc --noEmit"
      via: "commande dans pre-commit"
      pattern: "tsc"
    - from: ".simple-git-hooks.json"
      to: "pnpm build (rslib build)"
      via: "commande dans pre-commit"
      pattern: "build"
---

<objective>
Ajouter la vérification des types TypeScript (`tsc --noEmit`) et le build (`pnpm build`) dans le hook pre-commit, après le lint/format et les tests existants.

Purpose: Garantir qu'aucun commit n'introduit d'erreur de types ou casse le build du projet.
Output: `.simple-git-hooks.json` mis à jour — le hook exécute `npx lint-staged && pnpm test && pnpm exec tsc --noEmit && pnpm build` à chaque commit.
</objective>

<execution_context>
@/workspaces/wsqlite/.github/get-shit-done/workflows/execute-plan.md
@/workspaces/wsqlite/.github/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<!-- État actuel du hook :
  .simple-git-hooks.json : { "pre-commit": "npx lint-staged && pnpm test" }
  tsconfig.json : noEmit: true déjà configuré — `tsc --noEmit` suffit
  package.json "build": "rslib build" — lancé via `pnpm build`
-->
</context>

<tasks>

<task type="auto">
  <name>Task 1: Ajouter typecheck et build au hook pre-commit</name>
  <files>.simple-git-hooks.json</files>
  <action>
    Modifier `.simple-git-hooks.json` pour enchaîner lint-staged, tests, typecheck et build :

    ```json
    {
      "pre-commit": "npx lint-staged && pnpm test && pnpm exec tsc --noEmit && pnpm build"
    }
    ```

    Ordre d'exécution et raisonnement :
    1. `npx lint-staged` — format + lint Biome sur les fichiers stagés (rapide)
    2. `pnpm test` — suite rstest complète (détecte les régressions)
    3. `pnpm exec tsc --noEmit` — vérification des types TypeScript sans émettre de fichiers (tsconfig.json a déjà `noEmit: true` mais la commande CLI l'impose explicitement pour éviter toute confusion)
    4. `pnpm build` — build rslib complet pour s'assurer que le projet compile en dist/

    Si l'une des étapes échoue, les suivantes ne s'exécutent pas et le commit est bloqué.

    Après modification, réinstaller le hook :
    ```bash
    pnpm simple-git-hooks
    ```

    Vérifier que `.git/hooks/pre-commit` contient bien la nouvelle commande complète.
  </action>
  <verify>
    <automated>grep -q "tsc --noEmit" /workspaces/wsqlite/.simple-git-hooks.json && grep -q "pnpm build" /workspaces/wsqlite/.simple-git-hooks.json && grep -q "tsc" /workspaces/wsqlite/.git/hooks/pre-commit && pnpm --dir /workspaces/wsqlite exec tsc --noEmit && echo "OK"</automated>
  </verify>
  <done>
    - `.simple-git-hooks.json` contient `npx lint-staged && pnpm test && pnpm exec tsc --noEmit && pnpm build`
    - `.git/hooks/pre-commit` reflète la nouvelle commande complète
    - `pnpm exec tsc --noEmit` se termine avec exit code 0 (aucune erreur de types)
    - `pnpm build` se termine avec exit code 0 (build réussi)
  </done>
</task>

</tasks>

<verification>
- `.simple-git-hooks.json` contient les 4 étapes : lint-staged, test, tsc --noEmit, build
- `.git/hooks/pre-commit` est exécutable et contient la commande mise à jour
- `pnpm exec tsc --noEmit` passe (exit code 0)
- `pnpm build` passe (exit code 0)
</verification>

<success_criteria>
Le hook pre-commit bloque tout commit dont les types TypeScript sont invalides ou dont le build échoue, tout en conservant le lint/format Biome et les tests rstest existants.
</success_criteria>

<output>
After completion, create `.planning/quick/260324-epa-ajoute-galement-un-test-des-types-et-que/260324-epa-SUMMARY.md`
</output>
