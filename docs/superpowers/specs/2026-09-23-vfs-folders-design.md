# One folder per OPFS VFS — design

**Date:** 2026-09-23 · **Status:** approved in chat, spec under review · **Target:** rc.6 (`## Unreleased`) · **Branch:** `feat/vfs-folders`

Four VFS — `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS` — resolve one database name to one OPFS file. Deleting through any of them destroys what the others created, and a client of one beside a live client of another reads an empty or stale database (CROSS-VFS, `mem:vfs`; the follow-up "Mixing VFS of the `opfs-path` family"). The library documents it as an exception and builds its lock namespace around it.

This design removes the exception. Each of the four keeps its files in a folder of its own, so **a database belongs to the VFS that wrote it, on every VFS, by construction** — as it already is for the IndexedDB VFS and `AccessHandlePoolVFS`. Every section below was decided in chat on 2026-09-23.

---

## 1. The declaration

`VFS_CAPABILITIES` gains `folder?: string` and loses `layout`.

| VFS | `folder` |
|---|---|
| `OPFSAdaptiveVFS` | `ad` |
| `OPFSAnyContextVFS` | `ac` |
| `OPFSCoopSyncVFS` | `cs` |
| `OPFSWriteAheadVFS` | `wa` |
| every other VFS | absent |

The folder on disk is `.` + the declared value — `.ad`, `.ac`, `.cs`, `.wa`. The leading dot (user, 2026-09-23) keeps the library's folders apart from an application's own OPFS entries; database names may start with a dot.

- **`folder` carries two meanings, and its JSDoc says both:** the directory the library places the database in, and the fact that this VFS addresses its files by path — the database IS the OPFS entry at that path. The second is not a coincidence of the first: a folder only makes sense where the library's name is the file's name.
- **`layout` is removed; `storage` plus `folder` say everything it said.**

  | old `layout` | now |
  |---|---|
  | `opfs-path` | `storage: 'opfs'`, `folder` present |
  | `opfs-pool` | `storage: 'opfs'`, `folder` absent |
  | `idb-store` | `storage: 'indexeddb'` |
  | `memory` | `storage: 'memory'` |

  `VFSLayout` is removed from the exports with it. `OPFSPermutedVFS`, the only upstream VFS that wrote to two storages, was removed from this library on 2026-08-20 and is deprecated upstream (#317), so a single `storage` is enough.
- Every reader of `layout` is rewritten on these terms: `deleteDatabaseFiles` in the worker (presence by OPFS entry, `jDelete` or not, the `removeOpfsEntry` pass, the `idb-store` barrier), `delete.ts`'s memory short-circuit, `sharesStorage`, and the tests reading it (`tests/browser/helpers.ts`, `target.ts`, `delete.test.ts`, `capabilities.test.ts`, the comments of conformance invariant 7).
- **A forgotten `folder` on a future path-addressed VFS makes it a pool**: `deleteDatabase` would rely on `jDelete` alone. Conformance invariant 7 ("a deleted database is gone") catches it, as it does today for a wrong `layout`.

## 2. Where the folder is applied

**One helper, `databasePath(vfs, file)`, applied where database identity is computed** — `.folder/file` when the VFS declares a folder, `file` unchanged otherwise. It lives beside `normalizeDatabaseFile` in `src/utils.ts`, and the identity becomes:

```ts
const dbFile = databasePath(vfs, normalizeDatabaseFile(file));
```

at the three entry points that compute it today: `createSQLiteClient` (`src/client.ts`), `deleteDatabase` (`src/delete.ts`) and `inspectDatabase` (`src/inspect.ts`).

- **The path is the identity everywhere downstream** — every lock name, the epoch registry, client markers, `bulk`, and the name posted to the workers. The init lock is taken both in the worker and on `deleteDatabase`'s main thread; one identity for both is what keeps an open and a deletion mutually exclusive.
- **The worker is untouched by the folder.** It receives `.ad/data` and opens it; the four VFS create intermediate directories with `{ create }` (`OPFSAdaptiveVFS.js:22`, `OPFSAnyContextVFS.js:17`, `OPFSCoopSyncVFS.js:144`, `OPFSWriteAheadVFS.js:902`), and `removeOpfsEntry` / `opfsEntryExists` already walk path segments. It changes in two places only, neither about the folder: where it reads `layout` (§1), and the import of the suffix list (§4).
- **The logical name stays public.** `db.file`, `InspectionBase.file` and error messages carry the name the consumer wrote, normalized — never the path. `db.file` is documented as what to pass back to `inspectDatabase` and `deleteDatabase`; carrying the path would make that `.ad/.ad/data`.
- **The name budget shrinks by four characters on the four VFS** — §2a.

## 2a. The length guard

SQLite refuses a path when `nPathname + 8 > mxPathname`, and `mxPathname` is 64 on every wa-sqlite VFS (`VFS.js:10`, inherited by all nine). So **the path — folder included — may be 56 characters at most**: 52 for the name on the four folder VFS, 56 elsewhere. Nothing checks it today; a longer name fails later, at open, inside the worker.

- **Checked where the path is computed** (§2), at the three entry points: `createSQLiteClient` throws synchronously, `deleteDatabase` and `inspectDatabase` reject — all with `INVALID_OPTION`, before any worker, lock or storage call.
- **Counted on the normalized path**, which is what SQLite receives: `normalizeDatabaseFile` percent-encodes, so a non-ASCII character costs three characters per UTF-8 byte (`café` is `caf%C3%A9`, 9). The message says so, and gives the bound for that VFS: `'<name>' is N characters once normalized; <vfs> accepts at most M.`
- **The bound is one named constant**, `64 - 8`, with the source of both numbers in its comment.
- **Declared, then executed:** a browser test opens and writes a database whose path is exactly at the bound, so the matrix runs it on all 22 pairs. If a VFS's `xFullPathname` ever lengthened the name, that test is what would say so.

## 3. Lock names

- **`namespaceFor` is removed; lock names use the VFS name directly.** `bsq:init:OPFSAdaptiveVFS:ad/data` and `bsq:init:OPFSCoopSyncVFS:cs/data` are two locks for two files.
- **`bsq:sweep` gains the VFS**: `bsq:sweep:<vfs>:<file>`. Two clients of different VFS on one name no longer skip each other's staging sweep.
- **`bsq:staging` stays as it is.** Its table name carries a UUID, so no two VFS can produce the same lock, and it is a liveness marker the sweep reads: renaming it would let a new tab's sweep drop a live staging table held by an rc.5 tab on the same `idb-store` or `opfs-pool` database during a deploy.
- **Compatibility across a deploy, which this preserves:** for the five VFS without a folder, every lock name except `bsq:sweep` is byte-identical to rc.5 — `namespaceFor` already returned the VFS name for them, and their path is the logical name. An rc.5 tab and an rc.6 tab on one such database still exclude each other. For the four folder VFS the two tabs are on different files, so there is nothing to exclude.

## 4. `db.files`

```ts
/**
 * Every name this database's files may have, as the VFS receives them: the
 * database, `-journal`, `-wal`, and the VFS's own extra files. On a VFS with a
 * `folder` these are OPFS paths; elsewhere they are the names inside the VFS's
 * own store. Empty on the memory VFS.
 */
readonly files: readonly string[];
```

- **Derived, not observed**: `databasePath(vfs, file)` followed by `''`, `-journal`, `-wal` and `extraFileSuffixes`, computed once at construction. It lists where files may be, including a `-journal` left by an earlier session — which an observation would miss.
- `DB_RELATED_SUFFIXES` moves out of `worker.ts` to sit with the helper, and the worker imports it: one list for `db.files` and for `deleteDatabaseFiles`.
- **`deleteDatabase` does not use `db.files`** — it has no client. It keeps its own derivation from the same helper and the same suffix list.

## 5. `deleteDatabase`

- Removes the database's files under the path (§2), exactly as today.
- **Leaves the VFS folder in place, empty or not.** Removing it would race a first open of another database in the same folder: the VFS takes the directory handle, then awaits before `getFileHandle`, and the two databases share no lock. An empty two-letter folder in OPFS costs nothing.
- Its `INVALID_OPTION` message, and `inspectDatabase`'s, drop "Four VFS share one underlying file": `vfs` stays required because a VFS still decides where the data is.

## 6. Existing databases — not migrated

A database created by rc.5 or earlier on one of the four VFS sits at the OPFS root and is not found by rc.6. **No migration code ships** — no probe at open, no exported migration function: this is a pre-1.0 release never announced to anyone, and a check on every open would cost every consumer for them.

The `## Unreleased` section of `CHANGELOG.md` carries it under **Breaking**, with a short snippet that moves a database's files from the root into its VFS folder. **The snippet is executed on Chromium and Firefox before it is written into the CHANGELOG.**

The same Breaking entry lists: `layout` and `VFSLayout` removed, `folder` added; the name bound of the four VFS going from 56 to 53 characters. `db.files` goes under Added; the length guard (§2a) under Changed — a too-long name now fails with `INVALID_OPTION` at the call instead of at open.

## 7. What goes with the shared-file exception

- `sharedStoreVfs` in `scripts/render-vfs-matrix.ts`, its generated spans, and the hand-written sentences around them: the exception in the `[!IMPORTANT]` callout of `VFS.md` and the `[!WARNING]` of `API.md`'s `deleteDatabase`. The callout keeps its rule — a database belongs to the VFS that wrote it — without the exception.
- `DatabaseClient.vfs`'s JSDoc ("Four VFS share the `opfs` namespace"), `InspectDatabaseOptions.vfs`'s, and `VFSLayout`'s.
- The comments naming a "staging sweep" in `worker.ts` that does not exist (`src/locks.ts:184`, `scripts/render-vfs-matrix.ts:552`) go with the code around them.
- `close()`'s JSDoc (`src/api.ts`) still says "this library does not yet expose a deletion" and describes removing files by name at the OPFS root. It is rewritten to point at `deleteDatabase` and `db.files`.
- `db.file`'s JSDoc ("the identity every lock name is built on") becomes the logical name the consumer passed, normalized.

## 8. Tests

**Unit**
- `databasePath`: the folder for each of the four VFS, the name unchanged for the five others; idempotence is not claimed (`databasePath` of a path adds a second folder, and nothing calls it twice).
- `capabilities.test.ts`: `folder` is declared exactly on `storage: 'opfs'` VFS whose files are addressed by path, two letters, unique; the `layout` ↔ `storage` assertions are removed.
- The tests asserting the shared namespace are **inverted, not deleted** — `tests/unit/locks.test.ts` (`namespaceFor`, and the cases at 155, 179, 438), `tests/unit/epochs.test.ts:121`, `tests/unit/inspect.test.ts:150`: two folder VFS on one name share no lock, no epoch counter, and do not see each other's clients.
- `bsq:sweep` carries the VFS; `bsq:staging` is unchanged.
- The length guard: a path of 56 characters accepted and 57 refused, on a folder VFS (53 / 54 for the name) and on one without; a percent-encoded name counted after normalization; all three entry points refuse with `INVALID_OPTION` and `deleteDatabase` / `inspectDatabase` touch no lock.

**Browser**
- **Isolation**, on a ring so each folder VFS is both writer and reader once — `ad`→`ac`, `ac`→`cs`, `cs`→`wa`, `wa`→`ad`: a table written through the first and its client closed, the same name opened through the second reads an empty database; `deleteDatabase` through the other answers `DATABASE_NOT_FOUND` and the first still reads its table.
- **`db.files` covers what the VFS writes**: after a write workload on each folder VFS, every entry in its folder belonging to the database is in `db.files` — which is where `-wa0` / `-wa1` must show up for `OPFSWriteAheadVFS`.
- **A path exactly at the bound opens and persists** on the target pair — hence on all 22 in the matrix (§2a).
- **Deletion leaves the folder**: after `deleteDatabase`, no entry of `db.files` remains and the folder does.
- **Every browser test that touches OPFS by bare name is moved to the path** — `helpers.ts:80`, `barrier`, `init`, `output`, `lifecycle`, `exclusive-connection`, `coopsync-handover`, `coopsync-retry`, `statement-errors`, `open-retry`, `default-pragmas` — through `db.files` where a client exists and `databasePath` otherwise. Their cleanups swallow `NotFoundError`, so a missed one would not fail: it would leak files between tests.

**Bench**
- The pre-run sweep, which recognises residue by the `bench-` prefix at the OPFS root, also descends into the four folders.
- The per-column `cleanupOpfs(file)` removes `db.files` instead of the bare name. The root diff needs nothing: it sees a folder appear and removes it at the end of the run.
- `scripts/bench/check.mjs` passes on Chromium and Firefox.

**Verification at delivery:** `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm test:conformance` on both engines, `pnpm docs:vfs` with `git diff --exit-code`, and **the full matrix** — `VFS_CAPABILITIES` and every per-VFS path change (`mem:conventions`, "When to run the full matrix").

## 9. Out of scope

- **Unexporting `VFS_CAPABILITIES`** — `mem:follow-ups`, "Unexport `VFS_CAPABILITIES`". Until then this change to the table is breaking and says so.
- **Removing empty consumer subdirectories** (`ad/app/` left by deleting `ad/app/data`) — pre-existing for any name with a slash.
- **Memories**, at closure: `mem:vfs` (CROSS-VFS becomes history of a fixed defect), `mem:architecture` (lock namespace), and the follow-up "Mixing VFS of the `opfs-path` family" is deleted.
