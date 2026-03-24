---
phase: quick
plan: 260324-fkx
type: execute
wave: 1
depends_on: []
files_modified:
  - package.json
  - src/client.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "@lalex/console est à la version stable 2.0.0"
    - "Le chunk du worker s'appelle wsqlite dans le bundler"
  artifacts:
    - path: "package.json"
      provides: "Dépendance @lalex/console à jour"
      contains: '"@lalex/console": "2.0.0"'
    - path: "src/client.ts"
      provides: "webpackChunkName wsqlite pour le worker"
      contains: 'webpackChunkName: "wsqlite"'
  key_links:
    - from: "package.json"
      to: "pnpm-lock.yaml"
      via: "pnpm install"
      pattern: "@lalex/console"
---

<objective>
Mettre à jour @lalex/console de la version rc vers la version stable, et renommer le chunk webpack du worker en "wsqlite".

Purpose: @lalex/console 2.0.0 est disponible sur npm (stable) — il faut sortir de la version rc. Le nom de chunk "sqlite" est générique, "wsqlite" reflète le nom du projet.
Output: package.json mis à jour, lockfile régénéré, webpackChunkName corrigé dans client.ts.
</objective>

<execution_context>
@/workspaces/wsqlite/.claude/get-shit-done/workflows/execute-plan.md
@/workspaces/wsqlite/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Mettre à jour @lalex/console vers 2.0.0</name>
  <files>package.json</files>
  <action>
    Dans package.json, changer la version de @lalex/console :
    - De : `"@lalex/console": "2.0.0-rc.1"`
    - Vers : `"@lalex/console": "2.0.0"`

    Ensuite exécuter `pnpm install` pour régénérer pnpm-lock.yaml avec la nouvelle version.
  </action>
  <verify>
    <automated>node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); if(p.dependencies['@lalex/console'] !== '2.0.0') throw new Error('Version incorrecte: ' + p.dependencies['@lalex/console']); console.log('OK: @lalex/console =', p.dependencies['@lalex/console'])"</automated>
  </verify>
  <done>package.json contient "@lalex/console": "2.0.0" et pnpm-lock.yaml est à jour</done>
</task>

<task type="auto">
  <name>Task 2: Renommer le webpackChunkName du worker en wsqlite</name>
  <files>src/client.ts</files>
  <action>
    Dans src/client.ts, ligne 149, changer le webpackChunkName du Worker :
    - De : `new Worker(/* webpackChunkName: "sqlite" */ new URL('./worker.ts', import.meta.url), {`
    - Vers : `new Worker(/* webpackChunkName: "wsqlite" */ new URL('./worker.ts', import.meta.url), {`

    Un seul remplacement à faire — le commentaire magique webpack pour nommer le chunk généré.
  </action>
  <verify>
    <automated>grep -n 'webpackChunkName: "wsqlite"' /workspaces/wsqlite/src/client.ts && ! grep 'webpackChunkName: "sqlite"' /workspaces/wsqlite/src/client.ts && echo "OK: chunk renommé en wsqlite"</automated>
  </verify>
  <done>src/client.ts contient webpackChunkName: "wsqlite" et ne contient plus webpackChunkName: "sqlite"</done>
</task>

<task type="auto">
  <name>Task 3: Vérifier que le build passe</name>
  <files></files>
  <action>
    Exécuter `pnpm build` pour confirmer que la mise à jour de @lalex/console et le changement de chunk name ne cassent pas la compilation.
  </action>
  <verify>
    <automated>cd /workspaces/wsqlite && pnpm build</automated>
  </verify>
  <done>Le build se termine sans erreur</done>
</task>

</tasks>

<verification>
- `package.json` contient `"@lalex/console": "2.0.0"` (sans `-rc`)
- `src/client.ts` contient `webpackChunkName: "wsqlite"` pour le Worker
- `pnpm build` réussit
</verification>

<success_criteria>
- @lalex/console à la version stable 2.0.0 dans package.json et pnpm-lock.yaml
- Le fichier worker généré par webpack/rspack s'appellera "wsqlite" (chunk name)
- Build sans erreur
</success_criteria>

<output>
After completion, create `.planning/quick/260324-fkx-met-a-jour-le-package-lalex-console-vers/260324-fkx-SUMMARY.md`
</output>
