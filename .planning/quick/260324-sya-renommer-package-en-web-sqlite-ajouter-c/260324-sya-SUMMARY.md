---
quick_id: 260324-sya
description: "Renommer package en web-sqlite, ajouter champs npm, anticiper rename repo"
status: completed
---

# Quick Task 260324-sya: Renommer package en web-sqlite

## Changes

- Renamed package from `wsqlite` to `web-sqlite` in package.json
- Added npm metadata: description, author (LAlex), license (MIT), repository, bugs, homepage, keywords
- Repository URLs point to `lalexdotcom/web-sqlite` (anticipating GitHub repo rename)
- Updated all source references: client.ts JSDoc imports, webpackChunkName, comments
- Updated README.md: all wsqlite → web-sqlite
- Updated test helpers: DB name prefix wsqlite-test → web-sqlite-test

## Files Modified

- `package.json`
- `src/client.ts`
- `README.md`
- `tests/browser/init.test.ts`
- `tests/browser/helpers.ts`
