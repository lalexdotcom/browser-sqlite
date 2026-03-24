---
phase: quick
plan: 260324-ebg
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - .simple-git-hooks.json
autonomous: true
requirements: []

must_haves:
  truths:
    - "Un commit ne peut pas passer si Biome détecte des erreurs de lint"
    - "Un commit ne peut pas passer si Biome détecte des erreurs de formatage"
    - "Seuls les fichiers stagés sont vérifiés (pas tout le projet)"
  artifacts:
    - path: ".simple-git-hooks.json"
      provides: "Configuration du hook pre-commit"
    - path: "package.json"
      provides: "Dépendances simple-git-hooks et lint-staged + script prepare"
  key_links:
    - from: ".git/hooks/pre-commit"
      to: "lint-staged"
      via: "simple-git-hooks installation"
      pattern: "npx lint-staged"
---

<objective>
Configurer un système de pre-commit qui formate et lint automatiquement les fichiers TypeScript/JavaScript stagés avant chaque commit, en utilisant Biome (déjà présent dans le projet) via simple-git-hooks + lint-staged.

Purpose: Garantir la cohérence du code à chaque commit sans vérifier l'ensemble du projet.
Output: Hook pre-commit fonctionnel, configuration lint-staged dans package.json.
</objective>

<execution_context>
@/workspaces/wsqlite/.claude/get-shit-done/workflows/execute-plan.md
@/workspaces/wsqlite/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/workspaces/wsqlite/package.json
@/workspaces/wsqlite/biome.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Installer simple-git-hooks et lint-staged, configurer le hook pre-commit</name>
  <files>package.json, .simple-git-hooks.json</files>
  <action>
    1. Installer les dépendances de dev :
       ```
       npm install --save-dev simple-git-hooks lint-staged
       ```

    2. Créer le fichier `.simple-git-hooks.json` à la racine du projet :
       ```json
       {
         "pre-commit": "npx lint-staged"
       }
       ```

    3. Dans `package.json`, ajouter la section `lint-staged` qui appelle `biome check --write` sur les fichiers JS/TS stagés :
       ```json
       "lint-staged": {
         "*.{js,ts,jsx,tsx,mjs,cjs}": [
           "biome check --write --no-errors-on-unmatched"
         ]
       }
       ```

    4. Ajouter le script `prepare` dans `package.json` pour installer les hooks automatiquement après `npm install` :
       ```json
       "prepare": "simple-git-hooks"
       ```

    5. Exécuter `npx simple-git-hooks` pour installer le hook dans `.git/hooks/pre-commit`.

    Note: `biome check --write` combine format + lint + organize imports en une seule passe. L'option `--no-errors-on-unmatched` évite les erreurs si lint-staged passe un type de fichier non couvert.
    Note: Biome est déjà configuré avec `vcs.enabled: true` et `vcs.clientKind: git`, mais lint-staged gère lui-même le filtrage des staged files, donc on n'utilise PAS `--staged` (lint-staged passe les fichiers en argument directement).
  </action>
  <verify>
    <automated>cat /workspaces/wsqlite/.git/hooks/pre-commit</automated>
  </verify>
  <done>
    - `.git/hooks/pre-commit` existe et contient la commande lint-staged
    - `simple-git-hooks` et `lint-staged` sont dans `devDependencies` de `package.json`
    - La section `lint-staged` est présente dans `package.json`
    - Le script `prepare` est présent dans `package.json`
  </done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>Hook pre-commit via simple-git-hooks + lint-staged + Biome. Le hook vérifie le lint et le formatage des fichiers JS/TS stagés avant chaque commit.</what-built>
  <how-to-verify>
    1. Créer un fichier de test avec une erreur de style intentionnelle :
       ```bash
       echo 'const x = "hello"' > /tmp/test-precommit.ts
       cp /tmp/test-precommit.ts /workspaces/wsqlite/test-precommit.ts
       ```
    2. Stager le fichier :
       ```bash
       git add /workspaces/wsqlite/test-precommit.ts
       ```
    3. Tenter un commit :
       ```bash
       git commit -m "test: pre-commit hook"
       ```
    4. Vérifier que Biome a soit reformaté le fichier automatiquement, soit bloqué le commit si non auto-fixable.
    5. Supprimer le fichier de test :
       ```bash
       git restore --staged /workspaces/wsqlite/test-precommit.ts
       rm /workspaces/wsqlite/test-precommit.ts
       ```
  </how-to-verify>
  <resume-signal>Tapez "approved" si le hook fonctionne, ou décrivez le problème rencontré.</resume-signal>
</task>

</tasks>

<verification>
- `cat .git/hooks/pre-commit` affiche un script appelant lint-staged
- `npx simple-git-hooks` s'exécute sans erreur
- `npm run prepare` s'exécute sans erreur
- `package.json` contient `simple-git-hooks`, `lint-staged` dans devDependencies, la section `lint-staged`, et le script `prepare`
</verification>

<success_criteria>
- Le hook pre-commit est installé dans `.git/hooks/pre-commit`
- Tout commit sur des fichiers TS/JS déclenche automatiquement `biome check --write`
- Les fichiers mal formatés ou avec des erreurs lint bloquent le commit (ou sont auto-corrigés si possible)
- Les fichiers non stagés ne sont pas affectés
</success_criteria>

<output>
After completion, create `.planning/quick/260324-ebg-ajoute-un-syst-me-de-precommit-qui-forma/260324-ebg-SUMMARY.md` with what was done, files modified, and any issues encountered.
</output>
