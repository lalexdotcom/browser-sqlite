# One folder per OPFS VFS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each path-addressed OPFS VFS keeps its files in a two-letter folder, so a database belongs to the VFS that wrote it on every VFS; `layout` gives way to `storage` + `folder`, lock names key on the VFS, `db.files` lists a database's files, and the path length is checked at the entry points.

**Architecture:** One helper, `resolveDatabase(file, vfs)`, turns the consumer's name into `{ file, path }` at the three entry points (`createSQLiteClient`, `deleteDatabase`, `inspectDatabase`). `path` (`ad/data`) is the identity everything downstream uses — locks, epochs, markers, bulk, the name posted to workers — and `file` (`data`) is what the public surface reports. The worker is not touched by the folder: the four VFS create intermediate directories themselves.

**Tech Stack:** TypeScript, wa-sqlite (pinned, patched), rstest (unit project in Node, browser projects on Chromium and Firefox via Playwright), biome, rslib.

**Spec:** `docs/superpowers/specs/2026-09-23-vfs-folders-design.md` — read it before any task; this plan argues from it.

## Global Constraints

- Folders: `OPFSAdaptiveVFS` → `ad`, `OPFSAnyContextVFS` → `ac`, `OPFSCoopSyncVFS` → `cs`, `OPFSWriteAheadVFS` → `wa`; no other VFS has one.
- `layout` and `VFSLayout` are removed; `storage` + presence of `folder` replace them (spec §1 table).
- `namespaceFor` is removed; lock names use the VFS name. `bsq:sweep` gains the VFS. **`bsq:staging` is not changed.**
- For the five VFS without a folder, every lock name except `bsq:sweep` stays byte-identical to rc.5.
- `db.file`, `InspectionBase.file` and every error message carry the logical name (normalized, no folder). `db.debug.file` carries the path — it is the identity, and tests build lock names from it.
- `deleteDatabase` never removes the VFS folder.
- Path bound: `MAX_DATABASE_PATH = 64 - 8` = 56 characters, counted on the normalized path, folder included.
- No migration code ships. The CHANGELOG migration snippet is executed on Chromium and Firefox before it is written.
- **Serena rule (AGENTS.md):** Serena's symbolic tools are primary for code — `get_symbols_overview`, `find_symbol`, `find_referencing_symbols` to read; `replace_symbol_body`, `insert_before_symbol` / `insert_after_symbol`, `replace_content`, `rename_symbol` to edit. Built-in Read/Edit/Grep on code files only as a fallback. Markdown, JSON and HTML may use Read/Edit.
- **Every commit:** run `pnpm check` (biome, writes fixes) and `pnpm exec tsc --noEmit` yourself first. **Never `--no-verify`, never set `SKIP_SIMPLE_GIT_HOOKS`, never touch `.git/hooks`, never run `simple-git-hooks`, `pnpm install` or `pnpm store prune`.** If the hook fails, stop and report its output verbatim. After committing, confirm with `git log --oneline -1` and `git show --stat HEAD`.
- Every commit lands green: the failing test and the code that satisfies it are in the same task and the same commit.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Markdown prose is not hard-wrapped (commit messages are).
- Browser test runs: `pnpm exec rstest --project 'chromium*' run <file>` and `pnpm exec rstest --config rstest.firefox.config.ts run <file>`; unit: `pnpm exec rstest --project unit run <file>`; conformance: `pnpm test:conformance`.

## Review Focus

1. **`db.file` handed back** — a consumer passes `db.file` to `deleteDatabase` / `inspectDatabase` and expects the same database, never `ad/ad/data`. Pinned in Task 4.
2. **A name with a slash on a folder VFS** — `app/data` becomes `ad/app/data`, opens, writes, and deletes cleanly. Pinned in Task 4.
3. **A non-ASCII name near the bound** — `café` costs 9 characters once normalized; the guard counts the normalized path, not the input. Pinned in Task 5.
4. **An rc.5 database left at the OPFS root** — on a folder VFS it is not found (`deleteDatabase` → `DATABASE_NOT_FOUND`), and the CHANGELOG snippet moves it into the folder where the client finds it. Pinned in Task 6.
5. **The five non-folder VFS unchanged across a deploy** — their `init`, `write`, `conn`, `client` and `epoch` lock names equal rc.5's exactly. Pinned in Task 3.

---

## File map

| File | Change |
|---|---|
| `src/types.ts` | `folder?` on `VFSCapability` and on the four entries; `layout`, `VFSLayout` removed; `folderOf(vfs)` added |
| `src/index.ts` | `VFSLayout` export removed |
| `src/utils.ts` | `DATABASE_FILE_SUFFIXES`, `MAX_DATABASE_PATH`, `databasePath`, `databaseFiles`, `resolveDatabase` |
| `src/locks.ts` | `namespaceFor` removed; names on `vfs`; `sweepLockName(vfs, file)`; `sharesStorage` on `storage` |
| `src/epochs.ts` | namespace is `vfs` |
| `src/bulk.ts` | `createBulk` takes `vfs` for the sweep lock |
| `src/client.ts` | identity from `resolveDatabase`; `db.files`; logical name in `db.file` and messages |
| `src/api.ts` | `files` on the client type; JSDoc of `file` and `close()` |
| `src/delete.ts` | identity from `resolveDatabase`; logical name in messages; memory check on `storage` |
| `src/inspect.ts` | `inspectWith` derives the path from the logical name; `inspectDatabase` uses `resolveDatabase` |
| `src/worker/worker.ts` | reads `storage` / `folderOf` instead of `layout`; imports `DATABASE_FILE_SUFFIXES` |
| `scripts/render-vfs-matrix.ts` | `sharedStoreVfs` and its two splices removed |
| `VFS.md`, `API.md`, `CHANGELOG.md` | exception removed, Breaking / Added / Changed entries |
| `scripts/bench/html/index.html` | sweep descends into folders; column cleanup from `db.files` |
| `tests/unit/*` | capabilities, utils, locks, epochs, inspect |
| `tests/conformance/helpers.ts` | `removeOpfsPath`; `conformanceClient` cleanup |
| `tests/conformance/folders.test.ts` | new: isolation ring, `db.files` coverage, folder survives deletion |
| `tests/browser/*` | every OPFS-by-name access moved to the path; `layout` readers |
| `tests/browser/vfs-folders.test.ts` | new: logical name round trip, slash in name, bound |

---

### Task 1: `folder` replaces `layout` in the declaration

A pure refactor: no behaviour changes. The four VFS still share one file after this task; `namespaceFor` keeps returning `'opfs'` for them.

**Files:**
- Modify: `src/types.ts` (`VFSLayout` type ~line 244, `VFSCapability` ~line 280, the nine entries, new `folderOf` after `VFS_CAPABILITIES`)
- Modify: `src/index.ts` (the named export list)
- Modify: `src/locks.ts` (`namespaceFor`, `sharesStorage`)
- Modify: `src/delete.ts:84`
- Modify: `src/worker/worker.ts` (`deleteDatabaseFiles`, ~lines 993-1105)
- Modify: `scripts/render-vfs-matrix.ts:560`
- Modify: `tests/unit/capabilities.test.ts:145-170`, `tests/unit/test-target.test.ts:110`, `tests/browser/target.ts:84,122`, `tests/browser/helpers.ts:160`, `tests/browser/delete.test.ts:147-210,255`, `tests/browser/helpers/vfs-contract.ts:19`, `tests/browser/inspect-client.test.ts:82`, `tests/conformance/invariants.test.ts:241-249`

**Interfaces:**
- Produces: `VFSCapability.folder?: string`; `folderOf(vfs: SQLiteVFS): string | undefined` exported from `src/types.ts`.

- [ ] **Step 1: Write the failing test.** Replace the `describe('VFS layout declarations', …)` block of `tests/unit/capabilities.test.ts` with:

```ts
describe('VFS folder declarations', () => {
  // Not documentation. `folder` is where the library places a database AND the
  // statement that this VFS addresses its files by path: `deleteDatabase` runs
  // its OPFS removal pass only where it is set, and OPFSCoopSyncVFS's jDelete
  // truncates without removing — a missing folder is a deletion that silently
  // leaves the file in place. Pinned by name, one line per VFS.
  it('gives each path-addressed OPFS VFS its own folder', () => {
    expect(folderOf('OPFSAdaptiveVFS')).toBe('ad');
    expect(folderOf('OPFSAnyContextVFS')).toBe('ac');
    expect(folderOf('OPFSCoopSyncVFS')).toBe('cs');
    expect(folderOf('OPFSWriteAheadVFS')).toBe('wa');
    expect(folderOf('AccessHandlePoolVFS')).toBeUndefined();
    expect(folderOf('IDBBatchAtomicVFS')).toBeUndefined();
    expect(folderOf('IDBMirrorVFS')).toBeUndefined();
    expect(folderOf('MemoryVFS')).toBeUndefined();
    expect(folderOf('MemoryAsyncVFS')).toBeUndefined();
  });

  it('declares folders only on OPFS, two letters each, never twice', () => {
    const folders = (Object.keys(VFS_CAPABILITIES) as SQLiteVFS[])
      .filter((vfs) => folderOf(vfs) !== undefined)
      .map((vfs) => {
        expect(VFS_CAPABILITIES[vfs].storage).toBe('opfs');
        return folderOf(vfs) as string;
      });
    for (const folder of folders) expect(folder).toMatch(/^[a-z]{2}$/);
    expect(new Set(folders).size).toBe(folders.length);
  });

  it('no longer declares a layout', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      expect('layout' in cap).toBe(false);
    }
  });
});
```

Add `folderOf` to the file's import from `../../src/types` (and `SQLiteVFS` as a type if not already imported).

- [ ] **Step 2: Run it to verify it fails.** `pnpm exec rstest --project unit run tests/unit/capabilities.test.ts` — expected: FAIL, `folderOf` is not exported.

- [ ] **Step 3: Change the declaration in `src/types.ts`.**
  - Delete the `VFSLayout` type and its JSDoc.
  - In `VFSCapability`, replace `readonly layout: VFSLayout;` and its JSDoc with:

```ts
  /**
   * The folder this library places the database in, inside the OPFS root —
   * and, by being set, the statement that this VFS addresses its files by
   * path: the database IS the OPFS entry at `<folder>/<name>`, beside its
   * `-journal`, `-wal` and `extraFileSuffixes`. Absent on every other VFS: an
   * OPFS VFS without one keeps a pool of files whose names are not the
   * database's (`AccessHandlePoolVFS`), and IndexedDB and memory have no path.
   *
   * `deleteDatabase` reads it to decide whether the database is an OPFS entry
   * it can test and remove by name — the pass that covers the two VFS whose
   * `jDelete` does not delete. A folder missing here is a deletion that
   * reports success over an intact file; conformance invariant 7 catches it.
   */
  readonly folder?: string;
```

  - In the nine entries, delete every `layout: …` line; add `folder: 'wa',` to `OPFSWriteAheadVFS`, `folder: 'ad',` to `OPFSAdaptiveVFS`, `folder: 'cs',` to `OPFSCoopSyncVFS`, `folder: 'ac',` to `OPFSAnyContextVFS`, each where `layout` was.
  - After `VFS_CAPABILITIES`, add:

```ts
/**
 * The VFS's folder, or `undefined`. Read through `VFSCapability` because the
 * `as const` table narrows each entry to its own literal type, and five of
 * them have no `folder` key at all.
 */
export const folderOf = (vfs: SQLiteVFS): string | undefined => {
  const capability: VFSCapability = VFS_CAPABILITIES[vfs];
  return capability.folder;
};
```

  - In `src/index.ts`, delete `type VFSLayout,` from the export list.

- [ ] **Step 4: Rewrite every reader of `layout`** on the spec §1 table.
  - `src/locks.ts` — `namespaceFor`: body becomes `folderOf(vfs) !== undefined ? 'opfs' : vfs` (import `folderOf`); its JSDoc's first line becomes "The storage namespace a VFS writes into — derived from its `folder`, NEVER from the VFS name." and drop the stale sentence "`worker/worker.ts:627` gates on `layout` for the same reason, in those words." `sharesStorage`: `VFS_CAPABILITIES[vfs].storage !== 'memory'`; its JSDoc's "`delete.ts:79` skips the same layout" becomes "`deleteDatabase` skips the same storage".
  - `src/delete.ts:84`: `if (capability.storage === 'memory') return;`
  - `src/worker/worker.ts` in `deleteDatabaseFiles`: replace `const layout = VFS_CAPABILITIES[vfs].layout;` with

```ts
  const { storage } = VFS_CAPABILITIES[vfs];
  // A folder is the declaration that the database IS the OPFS entry at its path.
  const byPath = folderOf(vfs) !== undefined;
```

    then `layout === 'opfs-path'` → `byPath` (two sites), `layout !== 'opfs-path'` → `!byPath`, `layout === 'idb-store'` → `storage === 'indexeddb'`. In the comments of that function and of `opfsEntryExists`, "the `opfs-path` layout" becomes "a VFS with a `folder`", "Not on the opfs-path layout" becomes "Not on a VFS with a folder", "for all four `opfs-path` VFS" becomes "for every VFS with a folder", "The gate is by layout declaration" becomes "The gate is by storage declaration", and "A future idb-store VFS" becomes "A future IndexedDB VFS". Import `folderOf` from `../types`.
  - `scripts/render-vfs-matrix.ts:560`: `.filter(([name]) => folderOf(name as SQLiteVFS) !== undefined)` (import `folderOf`, `SQLiteVFS`). Leave the splice markers alone — Task 6 removes them.
  - Tests: `tests/unit/test-target.test.ts:110`, `tests/browser/target.ts:84`, `tests/browser/delete.test.ts:255`, `tests/browser/helpers/vfs-contract.ts:19`, `tests/browser/inspect-client.test.ts:82`, `tests/conformance/invariants.test.ts:249` — `.layout !== 'memory'` → `.storage !== 'memory'` and `.layout === 'memory'` → `.storage === 'memory'`. `tests/browser/target.ts:122` (`case 'opfs-file'`): `return folderOf(vfs) !== undefined;`. `tests/browser/helpers.ts:160`: `if (VFS_CAPABILITIES[pair.vfs].storage === 'opfs' && folderOf(pair.vfs) === undefined) {` and its comment's "(`opfs-pool`, the only one)" becomes "(OPFS without a folder, the only one)". `tests/browser/delete.test.ts:147`: `const { storage } = VFS_CAPABILITIES[vfs];`, lines 154/182 `storage === 'memory'`, line 210 `const opfsEntries = storage === 'opfs';`. `tests/conformance/invariants.test.ts:241`: "change `OPFSCoopSyncVFS`'s `layout` away from `'opfs-path'`" becomes "remove `OPFSCoopSyncVFS`'s `folder`".

- [ ] **Step 5: Verify.** `pnpm exec tsc --noEmit` clean; `pnpm exec rstest --project unit run` all pass; `pnpm docs:vfs && git diff --exit-code VFS.md API.md` — no diff (the generated list is the same four VFS); `grep -rn "layout" src tests scripts --include=*.ts` returns only prose unrelated to `VFSCapability` (e.g. "layout" in bench comments is HTML, not searched).

- [ ] **Step 6: Commit.**

```bash
pnpm check && pnpm exec tsc --noEmit
git add -A src scripts tests
git commit -m "refactor(vfs): folder replaces layout in the declaration

storage plus the presence of folder say everything layout said; the four
path-addressed OPFS VFS declare ad, ac, cs and wa. No behaviour changes:
namespaceFor still groups them until the lock names move.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The identity helpers

**Files:**
- Modify: `src/utils.ts` (after `normalizeDatabaseFile`)
- Modify: `src/worker/worker.ts` (`DB_RELATED_SUFFIXES` removed, import added)
- Test: `tests/unit/utils.test.ts`

**Interfaces:**
- Consumes: `folderOf` (Task 1).
- Produces, all exported from `src/utils.ts`:
  - `DATABASE_FILE_SUFFIXES: readonly ['', '-journal', '-wal']`
  - `databasePath(vfs: SQLiteVFS, file: string): string`
  - `databaseFiles(vfs: SQLiteVFS, path: string): readonly string[]`
  - `resolveDatabase(file: string, vfs: SQLiteVFS): { readonly file: string; readonly path: string }`

- [ ] **Step 1: Write the failing tests** in `tests/unit/utils.test.ts`:

```ts
describe('databasePath', () => {
  it('places a database in its VFS folder', () => {
    expect(databasePath('OPFSAdaptiveVFS', 'data')).toBe('ad/data');
    expect(databasePath('OPFSAnyContextVFS', 'data')).toBe('ac/data');
    expect(databasePath('OPFSCoopSyncVFS', 'data')).toBe('cs/data');
    expect(databasePath('OPFSWriteAheadVFS', 'app/data')).toBe('wa/app/data');
  });

  it('leaves the name alone on a VFS without a folder', () => {
    for (const vfs of [
      'AccessHandlePoolVFS',
      'IDBBatchAtomicVFS',
      'IDBMirrorVFS',
      'MemoryVFS',
      'MemoryAsyncVFS',
    ] as const) {
      expect(databasePath(vfs, 'data')).toBe('data');
    }
  });
});

describe('databaseFiles', () => {
  it('lists the database, its SQLite siblings and the VFS extras', () => {
    expect(databaseFiles('OPFSWriteAheadVFS', 'wa/data')).toEqual([
      'wa/data',
      'wa/data-journal',
      'wa/data-wal',
      'wa/data-wa0',
      'wa/data-wa1',
    ]);
    expect(databaseFiles('IDBBatchAtomicVFS', 'data')).toEqual([
      'data',
      'data-journal',
      'data-wal',
    ]);
  });

  it('is empty on the memory VFS', () => {
    expect(databaseFiles('MemoryVFS', 'data')).toEqual([]);
    expect(databaseFiles('MemoryAsyncVFS', 'data')).toEqual([]);
  });
});

describe('resolveDatabase', () => {
  it('returns the normalized name and its path', () => {
    expect(resolveDatabase('./app/data', 'OPFSCoopSyncVFS')).toEqual({
      file: 'app/data',
      path: 'cs/app/data',
    });
    expect(resolveDatabase('/data', 'IDBMirrorVFS')).toEqual({
      file: 'data',
      path: 'data',
    });
  });
});
```

Import `databaseFiles`, `databasePath`, `resolveDatabase` from `../../src/utils`.

- [ ] **Step 2: Run to verify failure.** `pnpm exec rstest --project unit run tests/unit/utils.test.ts` — FAIL, not exported.

- [ ] **Step 3: Implement** in `src/utils.ts`, directly after `normalizeDatabaseFile` (add `folderOf` to the `./types` import):

```ts
/**
 * The database and the two siblings SQLite may leave beside it. The set is
 * upstream's own (`OPFSCoopSyncVFS.js:8`), not a guess: a stale `-journal` next
 * to a deleted database is a hot journal, and recreating a database of that
 * name would have SQLite attempt a rollback from it.
 */
export const DATABASE_FILE_SUFFIXES = ['', '-journal', '-wal'] as const;

/**
 * Where a VFS keeps a database: `<folder>/<file>` on a VFS that declares a
 * folder, the name unchanged elsewhere. `file` must already be normalized, and
 * this must be applied once — a path passed back in gains a second folder.
 */
export const databasePath = (vfs: SQLiteVFS, file: string): string => {
  const folder = folderOf(vfs);
  return folder === undefined ? file : `${folder}/${file}`;
};

/**
 * Every name a database's files may have, as the VFS receives them — OPFS
 * paths on a VFS with a folder, names inside the VFS's own store elsewhere.
 * Derived, not observed: it includes a `-journal` an earlier session left.
 */
export const databaseFiles = (
  vfs: SQLiteVFS,
  path: string,
): readonly string[] =>
  VFS_CAPABILITIES[vfs].storage === 'memory'
    ? []
    : [...DATABASE_FILE_SUFFIXES, ...VFS_CAPABILITIES[vfs].extraFileSuffixes].map(
        (suffix) => `${path}${suffix}`,
      );

/**
 * A database's two names, computed once at each entry point: `file`, what the
 * consumer wrote, normalized — reported by `db.file`, inspections and error
 * messages; and `path`, the identity every lock, the epoch registry, the
 * workers and the VFS use.
 */
export const resolveDatabase = (
  file: string,
  vfs: SQLiteVFS,
): { readonly file: string; readonly path: string } => {
  const normalized = normalizeDatabaseFile(file);
  return { file: normalized, path: databasePath(vfs, normalized) };
};
```

In `src/worker/worker.ts`, delete `DB_RELATED_SUFFIXES` and its JSDoc, add `DATABASE_FILE_SUFFIXES` to the existing `import { renderPragmas } from '../utils';`, and replace the three uses of `DB_RELATED_SUFFIXES` with `DATABASE_FILE_SUFFIXES`. Keep the sentence "On `AccessHandlePoolVFS` each sibling also occupies its own pool slot." as a one-line comment above the `jDelete` loop.

- [ ] **Step 4: Verify.** Unit project passes; `pnpm exec tsc --noEmit` clean.

- [ ] **Step 5: Commit** (`pnpm check`, `tsc`, then):

```bash
git add src/utils.ts src/worker/worker.ts tests/unit/utils.test.ts
git commit -m "feat(utils): database path, files and identity helpers

resolveDatabase gives the two names a database has: the normalized name
the public surface reports, and the path every lock and the VFS use. The
suffix list moves out of the worker so db.files and deleteDatabase read
one list. Nothing calls them yet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Lock names key on the VFS

After this task the four OPFS VFS no longer exclude each other while still sharing one file. That intermediate state lives for one commit; Task 4 separates the files.

**Files:**
- Modify: `src/locks.ts` (`clientMarkerName`, `parseClientMarker`, `namespaceFor` deleted, `initLockName`, `writeLockName`, `connectionLockName`, `sweepLockName`)
- Modify: `src/epochs.ts:17,105`
- Modify: `src/bulk.ts` (`createBulk` signature, line 332)
- Modify: `src/client.ts:1320`
- Test: `tests/unit/locks.test.ts`, `tests/unit/epochs.test.ts:120-133`, `tests/unit/inspect.test.ts:150-163`, `tests/browser/tx-write.test.ts:139`, `tests/browser/cross-tab.test.ts` (six `namespaceFor` sites)

**Interfaces:**
- Produces: `sweepLockName(vfs: SQLiteVFS, file: string): string` → `bsq:sweep:${vfs}:${file}`. `createBulk(shared: { file: string; vfs: SQLiteVFS; locks: Locks; logger: Logger; maxVariables?: number })`. `namespaceFor` no longer exists. `epochLockName(ns, file, n)` keeps its signature; callers pass the VFS name as `ns`.

- [ ] **Step 1: Write the failing tests.** In `tests/unit/locks.test.ts`:
  - Delete the `describe('namespaceFor', …)` block and `namespaceFor` from the import.
  - Replace `it('is shared by the opfs-path VFS and distinct per file', …)` in `writeLockName` with:

```ts
  it('is distinct per VFS and per file', () => {
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      writeLockName('OPFSCoopSyncVFS', 'a.db'),
    );
    expect(writeLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      writeLockName('OPFSAdaptiveVFS', 'b.db'),
    );
  });
```

  - Replace `it('is shared by VFS that open the same file', …)` in `initLockName` with:

```ts
  it('is distinct per VFS', () => {
    expect(initLockName('OPFSAdaptiveVFS', 'a.db')).not.toBe(
      initLockName('OPFSWriteAheadVFS', 'a.db'),
    );
  });
```

  - Every `sweepLockName('a.db')` becomes `sweepLockName('OPFSAdaptiveVFS', 'a.db')` (lines 167, 187, 408).
  - Replace `it('sees a sibling opened through another VFS of the same namespace', …)` with:

```ts
  it('ignores a marker of another VFS on the same name', () => {
    const lock = clientMarkerName('OPFSCoopSyncVFS', 'app.db', ID, 'SQLite 1');
    expect(parseClientMarker(lock, 'OPFSAdaptiveVFS', 'app.db')).toBeUndefined();
  });
```

  - Add (Review Focus 5):

```ts
describe('lock names of the VFS without a folder', () => {
  // A deploy leaves an rc.5 tab beside an rc.6 one. On these five VFS they are
  // on the same database, so every name they exclude each other on must be
  // exactly rc.5's. bsq:sweep is the one deliberate change.
  it('are byte-identical to rc.5', () => {
    expect(initLockName('IDBBatchAtomicVFS', 'app.db')).toBe(
      'bsq:init:IDBBatchAtomicVFS:app.db',
    );
    expect(writeLockName('IDBMirrorVFS', 'app.db')).toBe(
      'bsq:write:IDBMirrorVFS:app.db',
    );
    expect(connectionLockName('AccessHandlePoolVFS', 'app.db')).toBe(
      'bsq:conn:AccessHandlePoolVFS:app.db',
    );
    expect(clientMarkerName('IDBBatchAtomicVFS', 'app.db', ID, 'SQLite 1')).toBe(
      `bsq:client:IDBBatchAtomicVFS:app.db:${ID}:IDBBatchAtomicVFS:SQLite%201`,
    );
    expect(stagingLockName('app.db', '__bsq_staging_x')).toBe(
      'bsq:staging:app.db:__bsq_staging_x',
    );
  });

  it('puts the VFS in the sweep lock', () => {
    expect(sweepLockName('IDBBatchAtomicVFS', 'app.db')).toBe(
      'bsq:sweep:IDBBatchAtomicVFS:app.db',
    );
  });
});
```

  (`ID` is the UUID constant the marker tests already define; move the `describe` below it or reuse the same literal.)
  - `tests/unit/epochs.test.ts`: replace `it('shares one counter between VFS that open the same file', …)` with:

```ts
  it('keeps one counter per VFS on the same name', () => {
    const a = epochsFor('OPFSAdaptiveVFS', '/same', noOpLocks);
    const b = epochsFor('OPFSCoopSyncVFS', '/same', noOpLocks);
    a.bump();
    expect(b.current()).toBe(0);
  });
```

  - `tests/unit/inspect.test.ts`: replace `it('reports true across the opfs-path family, which shares one file', …)` with:

```ts
  it('ignores a client of another VFS on the same name', async () => {
    // Each VFS keeps its own files: a client of OPFSCoopSyncVFS on app.db
    // holds a different database than OPFSAdaptiveVFS's app.db.
    const locks = stubLocks([
      {
        name: clientMarkerName('OPFSCoopSyncVFS', 'app.db', ID_B, 'SQLite 1'),
        clientId: 'r2',
      },
    ]);
    await expect(
      libraryClientsHold(locks, 'app.db', 'OPFSAdaptiveVFS', ID_A),
    ).resolves.toBe(false);
  });
```

- [ ] **Step 2: Run to verify failure.** `pnpm exec rstest --project unit run tests/unit/locks.test.ts tests/unit/epochs.test.ts tests/unit/inspect.test.ts` — FAIL (type error on `sweepLockName` arity, equal names across VFS).

- [ ] **Step 3: Implement.**
  - `src/locks.ts`: delete `namespaceFor` and its JSDoc. In `clientMarkerName`, `parseClientMarker`, `initLockName`, `writeLockName`, `connectionLockName`, replace `${namespaceFor(vfs)}` with `${vfs}`. `connectionLockName`'s JSDoc paragraph "The key uses `namespaceFor(vfs)` for the same reason `writeLockName` does: the gate is by layout declaration, not by VFS name." becomes "Keyed on the VFS: each VFS keeps its own files, so two VFS on one name are two databases." `sweepLockName` becomes:

```ts
export const sweepLockName = (vfs: SQLiteVFS, file: string) =>
  `bsq:sweep:${vfs}:${file}`;
```

  - `src/epochs.ts`: remove the `namespaceFor` import; `const ns = namespaceFor(vfs);` → `const ns = vfs;`.
  - `src/bulk.ts`: add `vfs: SQLiteVFS;` to `createBulk`'s parameter type (import the type from `./types`), destructure it, and line 332 becomes `.tryWithLock(sweepLockName(vfs, file), async () => {`.
  - `src/client.ts:1320`: `createBulk({ file: dbFile, vfs, locks: createLocks(), logger })`.
  - `tests/browser/tx-write.test.ts:139`: `sweepLockName(db.vfs, db.debug!.file)`.
  - `tests/browser/cross-tab.test.ts`: remove the `namespaceFor` import; each `namespaceFor(vfs)` becomes `vfs`.

- [ ] **Step 4: Verify.** `pnpm exec tsc --noEmit`; unit project; `pnpm exec rstest --project 'chromium*' run tests/browser/tx-write.test.ts tests/browser/cross-tab.test.ts`; same on Firefox.

- [ ] **Step 5: Commit.**

```bash
git add -A src tests
git commit -m "refactor(locks): lock names key on the VFS

namespaceFor grouped the four path-addressed OPFS VFS because they shared
one file; they are about to stop sharing it. The sweep lock gains the VFS
too. bsq:staging does not change: its table name is a UUID, and renaming
it would let a new tab's sweep drop a live staging table an rc.5 tab holds.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The folder goes live

**Files:**
- Modify: `src/client.ts` (identity at line 353, message at 671, `inspect` at 1730, `get file`, new `get files`)
- Modify: `src/api.ts` (client type: `file` JSDoc, new `files`)
- Modify: `src/delete.ts` (`deleteDatabase`, `runDelete`)
- Modify: `src/inspect.ts` (`inspectWith`, `inspectDatabase`)
- Modify: `tests/conformance/helpers.ts` (`removeOpfsPath`, `conformanceClient`)
- Modify: `tests/browser/helpers.ts` (`removeDatabaseFiles`), and the OPFS-by-name sites listed in Step 5
- Create: `tests/conformance/folders.test.ts`, `tests/browser/vfs-folders.test.ts`

**Interfaces:**
- Consumes: `resolveDatabase`, `databasePath`, `databaseFiles` (Task 2); `folderOf` (Task 1).
- Produces: `db.files: readonly string[]` on the client; `removeOpfsPath(path: string): Promise<void>` exported from `tests/conformance/helpers.ts`; `inspectWith(locks, file, vfs, ownMarkerName?)` now takes the **logical** name and derives the path itself.

- [ ] **Step 1: Add the test helper** to `tests/conformance/helpers.ts`:

```ts
/**
 * Removes one OPFS entry by path, walking its folders. Missing is success. The
 * folders themselves are left: the library never removes them either.
 */
export const removeOpfsPath = async (path: string): Promise<void> => {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // Never created, or this VFS does not use OPFS at all.
  }
};
```

and change `conformanceClient`'s `afterEach` body to `for (const path of databaseFiles(vfs, databasePath(vfs, file))) await removeOpfsPath(path);` (import both from `../../src/utils`).

- [ ] **Step 2: Write the failing conformance tests** — create `tests/conformance/folders.test.ts`:

```ts
import { afterEach, describe, expect, it } from '@rstest/core';
import { deleteDatabase } from '../../src/delete';
import { folderOf, type SQLiteVFS } from '../../src/types';
import { databaseFiles, databasePath } from '../../src/utils';
import {
  ALL_VFS,
  conformanceClient,
  createReopened,
  expectNoWorkerLost,
  missingHere,
} from './helpers';

afterEach(expectNoWorkerLost);

const FOLDER_VFS = ALL_VFS.filter((vfs) => folderOf(vfs) !== undefined);

/** The entries of `path`'s folder whose name starts with the database's. */
const entriesBeside = async (path: string): Promise<string[]> => {
  const segments = path.split('/');
  const base = segments.pop() as string;
  let dir = await navigator.storage.getDirectory();
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  const names: string[] = [];
  for await (const name of (dir as any).keys()) {
    if (name.startsWith(base)) names.push(`${segments.join('/')}/${name}`);
  }
  return names;
};

const tableCount = async (file: string, vfs: SQLiteVFS) => {
  const db = createReopened(file, vfs);
  try {
    const rows = await db.read<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
    );
    return rows[0].n;
  } finally {
    await db.close();
  }
};

// Each VFS writes once and reads once: ad→ac, ac→cs, cs→wa, wa→ad.
describe('a database belongs to the VFS that wrote it', () => {
  FOLDER_VFS.forEach((writer, i) => {
    const reader = FOLDER_VFS[(i + 1) % FOLDER_VFS.length];
    const missing = missingHere(writer) ?? missingHere(reader);
    if (missing) {
      it.skip(`${writer} → ${reader} — skipped, no ${missing} in this browser`, () => {});
      return;
    }
    it(`${writer} → ${reader}`, async () => {
      const { file, db } = conformanceClient(writer);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.close();

      // Falsifiable: make databasePath return `file` unchanged and the reader
      // opens the writer's file, finding one table.
      expect(await tableCount(file, reader)).toBe(0);
      await expect(deleteDatabase(file, { vfs: reader })).resolves.toBeUndefined();
      // Deleting through the reader removed the reader's (empty) database only.
      expect(await tableCount(file, writer)).toBe(1);
      await deleteDatabase(file, { vfs: writer });
    });
  });
});

describe('db.files covers what the VFS writes', () => {
  for (const vfs of FOLDER_VFS) {
    const missing = missingHere(vfs);
    if (missing) {
      it.skip(`${vfs} — skipped, no ${missing} in this browser`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.transaction(async (tx) => {
        for (let i = 0; i < 50; i++) await tx.write('INSERT INTO t VALUES (?)', [i]);
      });
      const files = db.files;
      expect(files[0]).toBe(databasePath(vfs, db.file));
      // Falsifiable: drop extraFileSuffixes from databaseFiles and
      // OPFSWriteAheadVFS's -wa0 / -wa1 are found beside it but not listed.
      for (const entry of await entriesBeside(files[0])) {
        expect(files).toContain(entry);
      }
      await db.close();
    });
  }
});

describe('deleteDatabase leaves the VFS folder', () => {
  for (const vfs of FOLDER_VFS) {
    const missing = missingHere(vfs);
    if (missing) {
      it.skip(`${vfs} — skipped, no ${missing} in this browser`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { file, db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      const files = db.files;
      await db.close();
      await deleteDatabase(file, { vfs });

      expect(await entriesBeside(files[0])).toEqual([]);
      const root = await navigator.storage.getDirectory();
      await expect(
        root.getDirectoryHandle(folderOf(vfs) as string),
      ).resolves.toBeDefined();
    });
  }
});
```

`db.transaction(callback: (db: SQLiteTransactionDB) => Promise<T>)` — `tx.write` is the transaction's own write (`src/api.ts:397`).

- [ ] **Step 3: Write the failing browser tests** — create `tests/browser/vfs-folders.test.ts` (target-following: it runs on `TEST_TARGET`, and the matrix takes it to all 22 pairs):

```ts
import { describe, expect, it, onTestFinished } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';
import { inspectDatabase } from '../../src/inspect';
import { databasePath } from '../../src/utils';
import { TEST_TARGET } from './helpers';

const { vfs, build } = TEST_TARGET;
const persistent = VFS_CAPABILITIES[vfs].storage !== 'memory';

describe('the name a consumer uses', () => {
  (persistent ? it : it.skip)(
    'hands db.file back to deleteDatabase and inspectDatabase as the same database',
    async () => {
      const name = `vfs-folders-${crypto.randomUUID()}`;
      const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
      await db.write('CREATE TABLE t (a INTEGER)');
      // Falsifiable: return the path from `get file()` and the name becomes
      // `ad/ad/…` on a folder VFS — inspectDatabase then finds no client.
      expect(db.file).toBe(name);
      expect((await inspectDatabase(db.file, { vfs })).clients.length).toBe(1);
      await db.close();
      await expect(deleteDatabase(db.file, { vfs, build })).resolves.toBeUndefined();
    },
  );

  (persistent ? it : it.skip)('opens, writes and deletes a name with a slash', async () => {
    const name = `vfs-folders-${crypto.randomUUID()}/nested`;
    const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    onTestFinished(() => deleteDatabase(name, { vfs, build }).catch(() => {}));
    await db.write('CREATE TABLE t (a INTEGER)');
    expect(db.files[0]).toBe(databasePath(vfs, name));
    await db.close();
    await expect(deleteDatabase(name, { vfs, build })).resolves.toBeUndefined();
  });
});
```

Add `VFS_CAPABILITIES` to the imports from `../../src/types`.

- [ ] **Step 4: Run to verify failure.** `pnpm test:conformance` — the ring fails (the reader sees the writer's table) and `db.files` does not exist; `pnpm exec rstest --project 'chromium*' run tests/browser/vfs-folders.test.ts` fails on `db.files`.

- [ ] **Step 5: Wire the identity.**
  - `src/client.ts`: delete `const dbFile = normalizeDatabaseFile(file);` and its two-line comment (line 351-353). Directly after the build check (`if (!(capability.builds …)) { throw … }`), insert:

```ts
  // A database's two names. `dbFile` is the path — the identity every lock,
  // the epoch registry, bulk, the workers and the VFS use, and what
  // `db.debug.file` reports. `logicalFile` is the name the consumer wrote,
  // normalized: what `db.file`, inspections and messages report.
  const { file: logicalFile, path: dbFile } = resolveDatabase(file, vfs);
  const files = databaseFiles(vfs, dbFile);
```

    Replace the `normalizeDatabaseFile` import with `databaseFiles, resolveDatabase`. At line 671 the message uses `${logicalFile}`. In `inspect` (~1730), `inspectWith(locks, logicalFile, vfs, markerName)`; at line 895 likewise `inspectWith(locks, logicalFile, vfs, markerName)`. `get file()` returns `logicalFile`; add after it:

```ts
    get files() {
      return files;
    },
```

  - `src/api.ts`: the `file` JSDoc becomes `/** The database name you passed, normalized — what to hand back to \`inspectDatabase\` and \`deleteDatabase\`. */`; add after it:

```ts
  /**
   * Every name this database's files may have, as the VFS receives them: the
   * database, `-journal`, `-wal`, and the VFS's own extra files. On a VFS with
   * a folder these are OPFS paths; elsewhere they are names inside the VFS's
   * own store. Empty on the memory VFS.
   */
  readonly files: readonly string[];
```

  - `src/inspect.ts`: in `inspectWith`, add `const path = databasePath(vfs, file);` after the `sharesStorage` guard and pass `path` instead of `file` to `parseClientMarker` (line 128) and `writeLockName` (line 139); the returned object keeps `file`. Its JSDoc gains: "`file` is the logical name, normalized; the path is derived here." `inspectDatabase`'s last line becomes `return inspectWith(locks, resolveDatabase(file, vfs).file, vfs);` (imports: `databasePath`, `resolveDatabase` instead of `normalizeDatabaseFile`).
  - `src/delete.ts`: replace `const dbFile = normalizeDatabaseFile(file);` with `const { file: logicalFile, path: dbFile } = resolveDatabase(file, vfs);` and **move it above** `if (capability.storage === 'memory') return;` (Task 5's guard must run on every VFS). The `DATABASE_IN_USE` and `BUSY` messages use `${logicalFile}`. `runDelete` gains a second parameter `name: string` used in its three messages and in `spawnWorker(\`SQLite delete / ${name}\`)`; the call becomes `runDelete({ file: dbFile, vfs, build, wasm }, logicalFile)`.

- [ ] **Step 6: Move every OPFS-by-name test access to the path.** A missed one does not fail — its cleanup swallows `NotFoundError` and leaks, or its fixture lands where nothing reads it and the test passes for the wrong reason. Each site, with `vfs` the VFS that test uses:
  - `tests/browser/helpers.ts` `removeDatabaseFiles(name, vfs)`: body becomes `for (const path of databaseFiles(vfs, databasePath(vfs, name))) await removeOpfsPath(path);` (import `removeOpfsPath` from `../conformance/helpers`).
  - `tests/browser/abandon.test.ts:188` and `tests/browser/pool-savepoint.test.ts:20` call `createPoolWorker` directly: pass `file: databasePath(TEST_TARGET.vfs, file)`, as the client would. Their `removeDatabaseFiles(file, …)` calls stay as they are.
  - `barrier.test.ts:135,174`, `init.test.ts:33`, `output.test.ts:333`, `lifecycle.test.ts:171`, `exclusive-connection.test.ts:201,262`, `coopsync-retry.test.ts:54`, `coopsync-handover.test.ts:56-58`: replace the `root.removeEntry(<name>, …)` block with `await removeDatabaseFiles(<name>, <vfs>);` (import from `./helpers`).
  - `statement-errors.test.ts:227-236` `garbageFile`: it takes the pair's `vfs`, builds `const path = databasePath(vfs, file)`, walks/creates the folder (`getDirectoryHandle(segment, { create: true })` per segment) and writes the garbage at the path; `remove` is `() => removeOpfsPath(path)`. Its doc comment: "what a VFS with a folder opens at its path". Falsifiable as before — and now also by writing the file at the root, which must make the test red, not green.
  - `open-retry.test.ts`: the holder is sent `databasePath(VFS, file)`; inside the worker source, split the path on `/`, `getDirectoryHandle(segment, { create: true })` for each folder, then `getFileHandle(name, { create: true })`. The `BroadcastChannel` name stays `'ahp:/' + file` with `file` now the path — `OPFSCoopSyncVFS` names it after `new URL(zName, 'file://').pathname`, which is `/cs/<name>`.
  - `delete.test.ts:98,124`: `initLockName('OPFSAdaptiveVFS', databasePath('OPFSAdaptiveVFS', file))`. The "leaves no OPFS root entry named after the database" test becomes "leaves no OPFS entry named after the database": list the folder of `databasePath(vfs, dbName)` (the root when the VFS has no folder) instead of the root.
  - `write-lock-reclaim.test.ts:59,63,89`: `writeLockName(VFS, databasePath(VFS, file))`. `inspect.test.ts:49,71`: the foreign marker's file argument is `databasePath(<its vfs>, <name>)`. `cross-tab.test.ts`: every `dbName` passed to `epochLockName` or used in a `bsq:epoch:` prefix becomes `databasePath(vfs, dbName)`.
  - Sweep for any site this list missed: `grep -rn "getDirectory()" tests/browser tests/conformance` — every hit must either go through `databasePath` / `removeDatabaseFiles` / `removeOpfsPath`, or touch an entry that is not a database (the unsafe-handle probe, `AccessHandlePoolVFS`'s own directory, `.ahp-*` temporary directories, the handle-starvation fixture).

- [ ] **Step 7: Verify.** `pnpm exec tsc --noEmit`; unit project; `pnpm test:conformance` (both engines, the new file included); `pnpm test` (all three reports pass).

- [ ] **Step 8: Commit.**

```bash
git add -A src tests
git commit -m "feat(vfs): each path-addressed OPFS VFS keeps its own folder

createSQLiteClient, deleteDatabase and inspectDatabase resolve a name to
its path once; everything downstream uses the path and the public surface
keeps the name the consumer wrote. db.files lists every name the
database's files may have. Tests that reached OPFS by name follow.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The path length guard

**Files:**
- Modify: `src/utils.ts` (`MAX_DATABASE_PATH`, `resolveDatabase`)
- Test: `tests/unit/utils.test.ts`, `tests/unit/inspect.test.ts` (or wherever `inspectDatabase` is unit-tested), `tests/browser/vfs-folders.test.ts`

**Interfaces:**
- Produces: `MAX_DATABASE_PATH = 56` exported from `src/utils.ts`; `resolveDatabase` throws `SQLiteError('INVALID_OPTION')` beyond it.

- [ ] **Step 1: Write the failing tests** in `tests/unit/utils.test.ts`:

```ts
describe('resolveDatabase — the path bound', () => {
  const name = (length: number) => 'n'.repeat(length);

  it('accepts a path of exactly 56 characters, folder included', () => {
    expect(resolveDatabase(name(53), 'OPFSAdaptiveVFS').path).toHaveLength(56);
    expect(resolveDatabase(name(56), 'IDBBatchAtomicVFS').path).toHaveLength(56);
  });

  it('refuses one character more with INVALID_OPTION', () => {
    expect(() => resolveDatabase(name(54), 'OPFSAdaptiveVFS')).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTION' }),
    );
    expect(() => resolveDatabase(name(57), 'IDBBatchAtomicVFS')).toThrow(
      expect.objectContaining({ code: 'INVALID_OPTION' }),
    );
  });

  it('counts the normalized path, where a non-ASCII character costs three per UTF-8 byte', () => {
    // 'é' is two UTF-8 bytes and normalizes to '%C3%A9', six characters
    // (verified: new URL('é', 'file://').pathname is '/%C3%A9').
    // 8 × 6 = 48, + 'ad/' = 51: accepted.
    expect(resolveDatabase('é'.repeat(8), 'OPFSAdaptiveVFS').path).toHaveLength(51);
    // 9 × 6 = 54 > 53, though the input is 9 characters long.
    expect(() => resolveDatabase('é'.repeat(9), 'OPFSAdaptiveVFS')).toThrow(
      /once normalized/,
    );
  });

  it('names the bound for that VFS', () => {
    expect(() => resolveDatabase(name(60), 'OPFSWriteAheadVFS')).toThrow(
      /OPFSWriteAheadVFS accepts at most 53/,
    );
  });
});
```

Import `MAX_DATABASE_PATH` wherever the tests below use it.

Add to the unit tests of `deleteDatabase` and `inspectDatabase` (find them with `find_referencing_symbols` on each; if none exist in the unit project, add the two cases to `tests/browser/vfs-folders.test.ts` instead):

```ts
it('refuses a too-long name before taking any lock', async () => {
  const request = vi.spyOn(navigator.locks, 'request');
  await expect(
    deleteDatabase('n'.repeat(60), { vfs: 'IDBBatchAtomicVFS' }),
  ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  expect(request).not.toHaveBeenCalled();
});
```

(use the unit project's existing way of stubbing `navigator.locks`, as `tests/unit/inspect.test.ts` does with `stubLocks`, rather than `vi` if that is the local idiom), the same for `inspectDatabase`, and for `createSQLiteClient` a synchronous `expect(() => createSQLiteClient('n'.repeat(60), { vfs: TEST_TARGET.vfs })).toThrow(expect.objectContaining({ code: 'INVALID_OPTION' }))` in `tests/browser/vfs-folders.test.ts`.

In `tests/browser/vfs-folders.test.ts`, the executed bound (spec §2a):

```ts
  (persistent ? it : it.skip)('opens and persists a path exactly at the bound', async () => {
    const folder = databasePath(vfs, '').length; // 3 on a folder VFS, 0 elsewhere
    const name = 'b'.repeat(MAX_DATABASE_PATH - folder);
    onTestFinished(() => deleteDatabase(name, { vfs, build }).catch(() => {}));
    const db = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();
    const reopened = createSQLiteClient(name, { vfs, build, poolSize: 1 });
    const rows = await reopened.read<{ n: number }>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
    );
    expect(rows[0].n).toBe(1);
    await reopened.close();
  });
```

The name is fixed, so a crashed run leaves it behind; `deleteDatabase` in `onTestFinished` and a unique-enough fixed name per VFS (`databasePath` differs per VFS) keep the matrix cells apart. If a cell ever reuses a leftover, prefix the name with the first 8 characters of a UUID and shorten the `b` run by 8.

- [ ] **Step 2: Run to verify failure.** Unit project: the refusal cases fail (no guard).

- [ ] **Step 3: Implement** in `src/utils.ts`:

```ts
/**
 * The longest database path, folder included. SQLite refuses a path when
 * `nPathname + 8 > mxPathname` before calling `xOpen` (the 8 leaves room for
 * `-journal`), and `mxPathname` is 64 on every wa-sqlite VFS
 * (`node_modules/wa-sqlite/src/VFS.js:10`, inherited by all nine).
 */
export const MAX_DATABASE_PATH = 64 - 8;
```

and in `resolveDatabase`, before the `return`:

```ts
  const path = databasePath(vfs, normalized);
  if (path.length > MAX_DATABASE_PATH) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `'${file}' is ${normalized.length} characters once normalized; ${vfs} accepts at most ${MAX_DATABASE_PATH - (path.length - normalized.length)}.`,
    );
  }
  return { file: normalized, path };
```

- [ ] **Step 4: Verify.** Unit project; `pnpm exec rstest --project 'chromium*' run tests/browser/vfs-folders.test.ts` and on Firefox; `tsc`.

- [ ] **Step 5: Commit.**

```bash
git add -A src tests
git commit -m "feat(utils): refuse a database path SQLite cannot open

A path longer than 56 characters, folder included, used to fail later at
open inside the worker. It now fails at the call with INVALID_OPTION,
counted on the normalized path, and names the bound for that VFS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Documentation, JSDoc and the CHANGELOG

**Files:**
- Modify: `scripts/render-vfs-matrix.ts` (`sharedStoreVfs`, both splices, the API.md block and its comment)
- Modify: `VFS.md` (callout, lines ~10-17), `API.md` (`deleteDatabase` warning, lines ~341-345)
- Modify: `src/delete.ts:67` and `src/inspect.ts:210,240` messages/JSDoc, `src/inspect.ts:69` (`DatabaseClient.vfs` JSDoc), `src/api.ts` (`close()` `@remarks`)
- Modify: `CHANGELOG.md` (`## Unreleased`)
- Create then delete: `tests/browser/migration-snippet.test.ts` (Step 4)

- [ ] **Step 1: Remove the shared-file exception from the generator.** Delete `sharedStoreVfs`, the `splice(…'<!-- BEGIN GENERATED SHARED VFS …')` call on `VFS.md`, and the whole `API.md` block with its comment (`scripts/render-vfs-matrix.ts` ~546-570, ~651-657, ~664-684); drop imports that become unused.

- [ ] **Step 2: Edit the consumer documents by hand.**
  - `VFS.md` callout: keep the rule, drop the exception —

```md
> [!IMPORTANT]
> **A database belongs to the VFS that wrote it.** It is not visible through another — the bytes are still there, but nothing reads them, and changing `vfs` migrates nothing.
```

  - `API.md`: delete the `[!WARNING]` block about VFS sharing one file (both marker lines and the list included). Add `db.files` to the client's property list next to `db.file`, with the JSDoc's sentence. Where `API.md` states name rules, add: "A database name may be 56 characters once normalized — 53 on `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS`, which keep it in a folder of their own. A non-ASCII character counts three per UTF-8 byte."
  - Run `pnpm docs:vfs` and confirm nothing else in `VFS.md` moved.

- [ ] **Step 3: Source strings.**
  - `src/delete.ts:67`: `vfs is required. Pass the VFS the database was created with — VFS.md compares them. Each VFS keeps its own files, so the wrong one finds nothing to delete.`
  - `src/inspect.ts:240`: `vfs is required. Pass the VFS the database was created with — VFS.md compares them. Each VFS keeps its own files, so the wrong one reports on a different database.` and the JSDoc at 210: "The VFS the database was created with. Required, and not defaulted: each VFS keeps its own files, so guessing would report on a different database."
  - `src/inspect.ts:69` `DatabaseClient.vfs`: `/** The VFS this client opened the database with. */`
  - `src/api.ts` `close()` `@remarks`: replace the paragraphs from "Deleting files under `navigator.storage.getDirectory()`" to "check what your chosen VFS actually writes." with: "To remove a database, close every client on it and call `deleteDatabase(db.file, { vfs: db.vfs })`: it goes through the VFS, which is the only correct removal on `AccessHandlePoolVFS` and the IndexedDB VFS. `db.files` lists the names its files may have."
  - `grep -rn "share one\|shares one\|one underlying file\|opfs namespace\|namespaceFor\|layout" src scripts/render-vfs-matrix.ts` — nothing about the shared file remains.

- [ ] **Step 4: Execute the migration snippet** (Review Focus 4). Create `tests/browser/migration-snippet.test.ts`, pinned to `OPFSAdaptiveVFS` (comment `// One VFS: the snippet is the same on all four, only the folder changes.`):

```ts
import { expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

it('the CHANGELOG snippet moves an rc.5 database into its folder', async () => {
  const name = `migration-${crypto.randomUUID()}`;
  // Stage an rc.5 database: write through the folder, then move the file to
  // the root, where rc.5 kept it.
  const staged = createSQLiteClient(name, { vfs: 'OPFSAdaptiveVFS', poolSize: 1 });
  await staged.write('CREATE TABLE t (a INTEGER)');
  await staged.close();
  const root = await navigator.storage.getDirectory();
  const ad = await root.getDirectoryHandle('ad');
  await (await ad.getFileHandle(name) as any).move(root);
  await expect(
    deleteDatabase(name, { vfs: 'OPFSAdaptiveVFS' }),
  ).rejects.toMatchObject({ code: 'DATABASE_NOT_FOUND' });

  // ── the snippet, verbatim ──
  const folder = await root.getDirectoryHandle('ad', { create: true });
  for (const suffix of ['', '-journal', '-wal']) {
    try {
      await (await root.getFileHandle(name + suffix) as any).move(folder);
    } catch (error) {
      if ((error as DOMException).name !== 'NotFoundError') throw error;
    }
  }
  // ── end ──

  const db = createSQLiteClient(name, { vfs: 'OPFSAdaptiveVFS', poolSize: 1 });
  const rows = await db.read<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'",
  );
  expect(rows[0].n).toBe(1);
  await db.close();
  await deleteDatabase(name, { vfs: 'OPFSAdaptiveVFS' });
});
```

Run it on `chromium*` and on the Firefox config. Both must pass. **If `FileSystemHandle.move` is missing on one engine, stop and report** — the snippet's shape is the user's call. Then delete the file; the CHANGELOG carries the snippet and the commit message records where it ran.

- [ ] **Step 5: CHANGELOG** — in `## Unreleased`, add a `### Breaking` section above `### Added` (create it; keep the existing sections' order otherwise):

```md
### Breaking

- **`OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS` and `OPFSWriteAheadVFS` keep each database in a folder of their own** — `ad/`, `ac/`, `cs/` and `wa/` in the OPFS root. Until now all four resolved one name to one file at the root, so deleting through any of them destroyed what the others created. A database created by an earlier release is not found: move its files into the folder once, before opening it —

  ```js
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle('ad', { create: true }); // ac, cs or wa for the other three
  for (const suffix of ['', '-journal', '-wal']) { // add '-wa0', '-wa1' for OPFSWriteAheadVFS
    try {
      await (await root.getFileHandle(name + suffix)).move(folder);
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
  }
  ```

  A name containing `/` keeps its subfolders inside the VFS folder. The other five VFS are unaffected.
- **`VFS_CAPABILITIES` loses `layout`, and `VFSLayout` is no longer exported.** `storage` says where a database lives; the new `folder` is set exactly on the four VFS above.
- **A database name on those four VFS may be 53 characters instead of 56**, once normalized — the folder takes three.

### Added

- **`db.files`** lists every name the database's files may have — the database, `-journal`, `-wal` and the VFS's own extra files — as OPFS paths on the four VFS above.
```

Merge the `db.files` bullet into the existing `### Added` rather than creating a second heading, and add under `### Changed`:

```md
- **A database name too long for SQLite now fails at the call**, with `INVALID_OPTION` naming the bound, from `createSQLiteClient`, `deleteDatabase` and `inspectDatabase` — it used to fail later, when the worker opened the file.
```

- [ ] **Step 6: Verify.** `pnpm docs:vfs && git diff --stat` shows only the intended `VFS.md` / `API.md` changes; `pnpm exec tsc --noEmit`; unit project; `pnpm exec biome ci .`.

- [ ] **Step 7: Commit.**

```bash
git add -A scripts src VFS.md API.md CHANGELOG.md
git commit -m "docs: each VFS keeps its own files

The shared-file exception leaves VFS.md, API.md and the messages. The
CHANGELOG migration snippet was executed on Chromium and Firefox (a
temporary browser test, removed) before it was written.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The bench

**Files:**
- Modify: `scripts/bench/html/index.html` (`cleanupOpfs` ~925, its call ~2733, `sweepBeforeRun` ~1123-1160)

The page imports `dist/index.js` only; `VFS_CAPABILITIES` is still exported and now carries `folder`.

- [ ] **Step 1: Column cleanup from `db.files`.** `cleanupOpfs(file)` becomes `cleanupOpfs(paths)`: for each path, walk its folders from the root with `getDirectoryHandle` and `withDeadline(dir.removeEntry(name, { recursive: true }))`, swallowing failures exactly as today, then `claimNewOpfsNames(root)`. The call at ~2733 becomes `await cleanupOpfs(ctx.db.files);` — `files` is readable after `close()`, and a reopen row's client has the same list.

- [ ] **Step 2: The pre-run sweep descends into the folders.** After the root loop in `sweepBeforeRun`, for each `folder` declared in `VFS_CAPABILITIES`: `getDirectoryHandle(folder)` (skip on `NotFoundError`), list it with `withDeadline(listOpfsRoot(dir))`, and remove every entry starting with `bench-` under the same `withDeadline` / `sweepLeft` / `forget` handling, reporting names as `${folder}/${name}`. The folders themselves are left. Update the JSDoc's list of "five things" to say `bench-` databases are found at the root and inside each VFS folder.

- [ ] **Step 3: Verify.** `pnpm bench:build && BENCH_PORT=8123 node scripts/bench/check.mjs chromium --all` → `OK`, `"reasons": {}`; the same with `firefox`. Then, to see the sweep work, run the check twice in a row and confirm the second run's export reports no `partial` sweep.

- [ ] **Step 4: Commit.**

```bash
git add scripts/bench/html/index.html
git commit -m "fix(bench): clean the VFS folders

The pre-run sweep recognised residue at the OPFS root only; bench
databases now live in ad/, ac/, cs/ and wa/. Each column removes its
database's files from db.files instead of a bare name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification

- [ ] **Step 1:** `pnpm exec tsc --noEmit`, `pnpm build`, `pnpm test` (three reports, all `pass`), `pnpm test:conformance` (both engines), `pnpm exec biome ci .`, `pnpm docs:vfs && git diff --exit-code VFS.md`, `pnpm test:consumer`, `pnpm lint` (warning count against `mem:state`'s baseline). Read every report; compare counts with `mem:state`'s verification baseline and account for each difference (new tests, removed tests).
- [ ] **Step 2:** `pnpm test:matrix` (~45 min) — `VFS_CAPABILITIES` and every per-VFS path changed (`mem:conventions`, "When to run the full matrix"). Start it with a progress monitor. A red cell: re-run that cell alone before diagnosing, then triage with `scripts/matrix-triage.mjs`.
- [ ] **Step 3:** Report every result verbatim to the user. No merge, no memory update here — both are the user's closure step.
