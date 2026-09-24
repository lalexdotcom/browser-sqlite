# The public surface — design

**Date:** 2026-09-24 · **Status:** approved in chat, spec under review · **Target:** rc.6 (`## Unreleased`) · **Branch:** `feat/public-surface`

The package exports more than a consumer can use, and every export is contract: each field of `VFS_CAPABILITIES`, internal ones included, is public since rc.4, so any change to the table is breaking. This chantier removes what has no consumer through the package, makes the client's declared type the one the declaration file prints, and takes in the leftovers of the `const/` split (`mem:follow-ups`, "Unexport `VFS_CAPABILITIES`" and "Left by the BUILD_CAPABILITIES / `const/` split").

**Success criterion:** the root entry exports exactly the names listed in § 1, the package declares no subpath but `.`, and the bench page runs as before.

---

## 1. What the entry exports afterwards

**Values:** `createSQLiteClient`, `deleteDatabase`, `inspectDatabase`, `detectFeatures`, `missingFeature`, `SQLiteError`, `SQLiteBulkWriteError`, `SQLITE_CODES`, `SQLITE_EXTENDED_CODES`.

**Types:** everything `src/api.ts` exports (unchanged, `export *`), `CreateSQLiteClientOptions`, `WorkerLostEvent`, `DeleteDatabaseOptions`, `InspectDatabaseOptions`, `DatabaseInspection`, `ClientInspection`, `InspectionBase`, `DatabaseClient`, `SQLiteVFS`, `SQLiteBuild`, `PlatformFeature`, `SQLiteErrorCode`, `SQLiteResultCode`, `SQLiteExtendedResultCode`.

## 2. Removed

| Name | Why it goes | Breaking |
|---|---|---|
| `VFS_CAPABILITIES`, `VFSCapability`, `VFSStorage`, `VFSMemoryModel` | Only the bench page reads the table through the entry (§ 4). No public signature names the three types. | yes — exported since rc.4 |
| `defaultBuildFor` | Only tests call it, and they import `src/capabilities` directly. A consumer reads the resolved build from `db.build`. | yes — exported in rc.5 |
| `folderOf` | No consumer through the package, documented nowhere. | no — added on `feat/vfs-folders` after rc.5, never published |
| the `./worker` subpath in `package.json` `exports` | The client spawns its worker by a URL relative to its own module (`src/pool.ts`, `spawnWorker`), which never goes through the exports map, and no option accepts a worker URL or a `Worker`. Without a bundler the browser never reads `package.json` at all. The commit that added it (`6efc057`) dropped `./dist/*` on the same argument. | yes — present in rc.5 |

All of them stay in the source: tests and scripts import `src/const/vfs.ts` and `src/capabilities.ts` directly and are untouched.

**Not exported, contrary to an earlier proposal:** `ClientDebugState`. `SQLiteDB.debug` is tagged `@internal` in `src/api.ts`; exporting its type would contradict the tag. Whether `db.debug` is public is settled by the documentation review (`mem:follow-ups`, "`db.debug`").

## 3. `createSQLiteClient` is declared to return `SQLiteDB`

Today the returned object is unannotated, so `dist/client.d.ts` prints a structural copy of its members, with `vfs` and `build` expanded to their unions, and nothing checks the object against `SQLiteDB`. The function gains an explicit return annotation, `): SQLiteDB =>`.

Checked on the current tree (2026-09-24): the function is assignable to `(file, options) => SQLiteDB`, the inferred type has exactly the keys of `SQLiteDB`, and `SQLiteDB & { foo: 1 }` is refused — so the annotation compiles as is and the check it adds is live. A member added to the object and not to `SQLiteDB` would disappear from the public type without an error (no excess-property check on a returned variable); that is accepted.

## 4. The bench page gets the table from the assembler

`scripts/bench/assemble.mjs` builds the page for `bench:build` and `bench:dev`. It imports `src/const/vfs.ts` (Node strips the types, as it already does for `scripts/render-vfs-matrix.ts`) and writes `<outDir>/vfs-capabilities.js`:

```js
export const VFS_CAPABILITIES = { … }; // JSON.stringify of the table
```

The page replaces `VFS_CAPABILITIES` in its `./dist/index.js` import with `import { VFS_CAPABILITIES } from './vfs-capabilities.js';`. Nothing else in the page changes. The table is JSON-safe (checked 2026-09-24: no `undefined` value, no non-finite number, no `Set` or `Map`).

Rejected: a `.json` fetched at startup (an `await` before the page can start, for no gain) and a placeholder substituted into the HTML like `__LIB_VERSION__` (an object literal spliced as text into a file nothing type-checks).

## 5. The split's leftovers

- **`SharedArrayTypes`** (`src/types/protocol.ts`) is deleted: no reference anywhere.
- **`src/inspect.ts` and `src/locks.ts`** import `./const/vfs` once each instead of twice.

## 6. Tests

`tests/unit/exports.test.ts`:

- **The runtime exports are pinned exactly**: `Object.keys(api).sort()` equals the values of § 1. It replaces the per-name presence checks for the removed names and the `DEFAULT_VFS` / `RECOMMENDED_VFS` / `BulkWriteError` absence checks, which the exact list subsumes. Falsifiable: re-export any removed name, or drop any kept one.
- **The removed types are pinned absent** at compile time, one `// @ts-expect-error` import each for `VFSCapability`, `VFSStorage`, `VFSMemoryModel`. Falsifiable: re-export one and `tsc` reports an unused directive.
- **The package declares only `.`**: `Object.keys(pkg.exports)` equals `['.']`. Falsifiable: restore `./worker`.
- **"exposes every wired VFS"** keeps its assertion but reads `src/const/vfs.ts`; its comment stops citing the bench.
- The `PATH_IMPORTERS` check stays as is and keeps guarding the bench's import from `dist/index.js`.

The bench page is exercised by `scripts/bench/check.mjs` after `pnpm bench:build`, on Chromium and Firefox.

## 7. Documentation

- **`CHANGELOG.md`, `## Unreleased`, Breaking.** Two lines go, because the release removes what they describe: "`VFS_CAPABILITIES` loses `layout`, and `VFSLayout` is no longer exported" and "`defaultBuildFor(vfs)` becomes `defaultBuildFor(vfs, available)`" (user). They are replaced by: `VFS_CAPABILITIES`, `VFSCapability`, `VFSLayout`, `VFSStorage`, `VFSMemoryModel` and `defaultBuildFor` are no longer exported — `db.build` reports the resolved build; and the `browser-sqlite/worker` subpath is gone. Nothing for `folderOf`.
- **`CHANGELOG.md`, Changed:** `createSQLiteClient` is declared to return `SQLiteDB`.
- **Consumer-facing prose stops naming internal symbols:** the last sentence of `VFS.md` § builds ("The pairing is declared in one place, `VFS_CAPABILITIES`…"), the two `@throws` of `createSQLiteClient` in `src/client.ts`, and the `build` doc comment in `src/api.ts` ("resolved by `defaultBuildFor`"). The generated-table marker comment in `VFS.md` is for maintainers and stays.
- **`mem:architecture`, "Public surface"** is rewritten from § 1; it is already stale (it names `BulkWriteError` and omits `SQLITE_CODES` and `deleteDatabase`). The `mem:follow-ups` entries this closes are deleted.

## Out of scope

- `Index`, `Interruptible` and `SQLiteQueryAPI` stay exported through `export * from './api'`.
- `db.debug` and `ClientDebugState`: the documentation review.
- A subpath for the `.wasm` files, which a `wasmUrl` setup might want.
