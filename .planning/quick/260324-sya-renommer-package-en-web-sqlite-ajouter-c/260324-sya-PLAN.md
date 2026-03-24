---
quick_id: 260324-sya
description: "Renommer package en web-sqlite, ajouter champs npm, anticiper rename repo"
tasks: 3
---

# Quick Plan: Renommer package en web-sqlite

## Task 1: Renommer dans package.json + ajouter champs npm
- **files**: `package.json`
- **action**: Changer name, ajouter description, author, license, repository, bugs, homepage, keywords

## Task 2: Renommer dans le code source
- **files**: `src/client.ts`
- **action**: Mettre à jour les imports JSDoc, le webpackChunkName, et les commentaires

## Task 3: Renommer dans README et tests
- **files**: `README.md`, `tests/browser/init.test.ts`, `tests/browser/helpers.ts`
- **action**: Remplacer wsqlite par web-sqlite partout
