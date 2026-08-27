# `deleteDatabase` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a consumer a supported way to delete a database and its journal siblings, on every persistent VFS, without touching any storage container.

**Architecture:** A standalone `deleteDatabase(file, options)` takes the origin-wide `bsq:init:<file>` lock, spawns one short-lived worker, instantiates the chosen VFS without opening anything, calls `jDelete` for `['', '-journal', '-wal']`, and — on the four VFS that keep the database as a plain OPFS entry — removes those entries itself, idempotently. Two of the seven persistent `jDelete` implementations do not delete; that second pass is what covers them, and it is written to become inert if upstream is fixed.

**Tech Stack:** TypeScript, rslib/rspack, rstest (unit + browser + conformance projects), wa-sqlite (vendored), Biome.

**Spec:** `docs/superpowers/specs/2026-08-27-delete-database-design.md` — read it before starting. This plan argues from it and does not repeat its rationale.

## Global Constraints

- **No new `SQLiteErrorCode`.** `INVALID_OPTION` for validation, `BUSY` for a held database, `TIMEOUT` for a delete that never answers, `WORKER_CRASHED` for the rest. All four already exist in the union.
- **Absence is success.** A database that is not there deletes without error, and a `NotFoundError` from `removeEntry` is success. This is what makes the second pass inert if upstream fixes its `jDelete`.
- **The second pass runs on all four `opfs-path` VFS**, not on an exception list of the two that need it.
- **`vfs` is required; `build` and `wasmUrl` are optional** and behave exactly as on `createSQLiteClient`, including the two synchronous validation throws.
- **No container is ever removed** — not the IndexedDB store, not the `AccessHandlePoolVFS` directory, not `.wa-sqlite/`.
- **`new Worker(new URL('./worker/worker.js', import.meta.url), …)` must remain one literal expression**, or bundlers stop following it. There is exactly one such expression in the codebase after Task 2, and there must still be exactly one at the end.
- Serena's symbolic tools are primary for code files (`get_symbols_overview`, `find_symbol`, `replace_symbol_body`, `replace_content`). Built-in Read/Edit are for `.md`, JSON, YAML and config only.
- Run `pnpm check` after every modification.
- Chat in French; code, comments, commit messages and docs in English.
- Work happens on branch `feat/delete-database`. The phase closes only when CI is green, memories are updated, and git is clean.
- Do **not** change the benchmark page. §9 of the spec explains why `sweepBeforeRun` stays.

---

### Task 1: `layout` on `VFSCapability`

The declaration the delete path reads to decide whether a database is an OPFS entry at its path. `storage` cannot answer it: `AccessHandlePoolVFS` is `storage: 'opfs'` and keeps opaque slots.

**Files:**
- Modify: `src/types.ts` (the `VFSCapability` type, and all nine `VFS_CAPABILITIES` entries)
- Modify: `src/index.ts` (export the new type)
- Test: `tests/unit/capabilities.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type VFSLayout = 'opfs-path' | 'opfs-pool' | 'idb-store' | 'memory'` and `VFSCapability.layout: VFSLayout`. Tasks 3 and 5 read `VFS_CAPABILITIES[vfs].layout`.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/capabilities.test.ts`. Add `VFS_CAPABILITIES` to its imports from `../../src/types` if it is not already there.

```ts
describe('VFS layout declarations', () => {
  // These are not documentation. `deleteDatabase` runs its OPFS removal pass
  // only for `opfs-path`, and OPFSCoopSyncVFS's jDelete truncates without
  // removing — so a wrong value here is a deletion that silently leaves the
  // file in place. Pinned by name, one line per VFS.
  it('names where each VFS keeps a database', () => {
    expect(VFS_CAPABILITIES.OPFSAdaptiveVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSAnyContextVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSCoopSyncVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.OPFSWriteAheadVFS.layout).toBe('opfs-path');
    expect(VFS_CAPABILITIES.AccessHandlePoolVFS.layout).toBe('opfs-pool');
    expect(VFS_CAPABILITIES.IDBBatchAtomicVFS.layout).toBe('idb-store');
    expect(VFS_CAPABILITIES.IDBMirrorVFS.layout).toBe('idb-store');
    expect(VFS_CAPABILITIES.MemoryVFS.layout).toBe('memory');
    expect(VFS_CAPABILITIES.MemoryAsyncVFS.layout).toBe('memory');
  });

  it('agrees with `storage` wherever both speak', () => {
    for (const cap of Object.values(VFS_CAPABILITIES)) {
      if (cap.layout === 'idb-store') expect(cap.storage).toBe('indexeddb');
      if (cap.layout === 'memory') expect(cap.storage).toBe('memory');
      if (cap.layout.startsWith('opfs-')) expect(cap.storage).toBe('opfs');
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:unit`
Expected: FAIL — `layout` is undefined on every entry, and `tsc` has not been asked yet.

- [ ] **Step 3: Add the type and the field**

In `src/types.ts`, beside `VFSStorage`:

```ts
/**
 * How a VFS arranges a database in its storage — which is not the same
 * question as `storage`, and cannot be derived from it: `AccessHandlePoolVFS`
 * is `storage: 'opfs'` yet keeps opaque, randomly named slot files whose
 * association with a SQLite path lives in a header inside each file.
 *
 * `deleteDatabase` reads this to decide whether the database is also an OPFS
 * entry it can remove by name after `jDelete` — the pass that covers the two
 * VFS whose `jDelete` does not delete. A wrong value here is a deletion that
 * reports success over an intact file.
 */
export type VFSLayout = 'opfs-path' | 'opfs-pool' | 'idb-store' | 'memory';
```

Add to `VFSCapability`, beside `storage`:

```ts
  /** How the database is arranged within that storage. */
  readonly layout: VFSLayout;
```

Then add the field to all nine entries, using the values pinned in Step 1. The type is required, so `tsc` names every entry still missing it.

- [ ] **Step 4: Export the type**

In `src/index.ts`, add `type VFSLayout,` to the named export block from `'./types'`, in alphabetical position beside `type VFSMemoryModel`.

- [ ] **Step 5: Run the checks**

Run: `pnpm check && npx tsc --noEmit && pnpm test:unit`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/index.ts tests/unit/capabilities.test.ts
git commit -m "feat(types): a VFS declares how it arranges a database"
```

---

### Task 2: `spawnWorker` and `busyFromCode`, extracted

The delete path needs both, and the `new Worker(new URL(…))` expression must not be duplicated. Pure refactor: no behaviour changes, and the existing suite is the proof.

**Files:**
- Modify: `src/pool.ts` (extract the Worker construction; export `busyFromCode`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const spawnWorker = (name: string): Worker` — a module worker on `./worker/worker.js`.
  - `export const busyFromCode = (data: { message: string; cause?: unknown; sqliteCode?: number }): SQLiteError | undefined` — already exists in `pool.ts` as a module-private const; only the `export` keyword is added.

- [ ] **Step 1: Extract `spawnWorker`**

In `src/pool.ts`, add above `createPoolWorker`:

```ts
/**
 * The single `new Worker(new URL(…))` expression in this package.
 *
 * It must stay one literal, in one place: bundlers find the worker by static
 * analysis of exactly this shape, and a second copy would have them emit a
 * second, untransformed worker bundle. `pool.ts:191` records what that cost
 * when the expression was written a second time for an error message.
 */
export const spawnWorker = (name: string): Worker =>
  new Worker(
    /* webpackChunkName: "browser-sqlite" */ new URL(
      './worker/worker.js',
      import.meta.url,
    ),
    { name, type: 'module' },
  );
```

Then replace the construction inside `createPoolWorker` so it reads:

```ts
  const workerName = `${clientPrefix} / Worker ${index + 1}`;
  const worker = Object.assign(spawnWorker(workerName) as PoolWorker, {
    index,
    status: 'NEW',
    seen: -1,
    epochTarget: 0,
  });
```

- [ ] **Step 2: Export `busyFromCode`**

In `src/pool.ts`, change `const busyFromCode = (data: {` to `export const busyFromCode = (data: {`. Nothing else moves.

- [ ] **Step 3: Prove nothing changed**

Run: `pnpm check && npx tsc --noEmit && pnpm test`
Expected: 358 tests pass, exactly as before.

- [ ] **Step 4: Prove the worker is still found by a bundler**

Run: `pnpm build && node scripts/consumer-smoke.mjs`
Expected: `24/24 stages passed`. This is the check that a refactor of this expression cannot skip.

- [ ] **Step 5: Commit**

```bash
git add src/pool.ts
git commit -m "refactor(pool): one worker construction site, two callers"
```

---

### Task 3: the delete round trip

Types, worker handler, client function, export, and a browser test that creates a database, closes it, deletes it, and reopens to find nothing.

**Files:**
- Modify: `src/types.ts` (the `delete` client message; the `deleted` worker message)
- Modify: `src/worker/worker.ts` (the handler)
- Create: `src/delete.ts`
- Modify: `src/index.ts` (export)
- Test: `tests/browser/delete.test.ts` (create)

**Interfaces:**
- Consumes: `VFS_CAPABILITIES[vfs].layout` (Task 1), `spawnWorker` and `busyFromCode` (Task 2), `resolveWasmLocation` and `normalizeDatabaseFile` (`src/utils.ts`), `initLockName` and `createLocks` (`src/locks.ts`), `defaultBuildFor` (`src/types.ts`).
- Produces: `export const deleteDatabase = (file: string, options: DeleteDatabaseOptions): Promise<void>` and `export type DeleteDatabaseOptions = { vfs: SQLiteVFS; build?: SQLiteBuild; wasmUrl?: string | ((build: SQLiteBuild) => string) }`. Task 4 adds the BUSY and TIMEOUT paths to the same function; Task 5 calls it from conformance.

- [ ] **Step 1: Write the failing test**

Create `tests/browser/delete.test.ts`:

```ts
import { afterEach, describe, expect, it } from '@rstest/core';
import { createSQLiteClient } from '../../src/client';
import { deleteDatabase } from '../../src/delete';

/**
 * The database is gone when a fresh client on the same name finds no table.
 * Asserted through the library rather than through OPFS, because half the VFS
 * do not keep a file at that name at all.
 */
const tableCount = async (file: string) => {
  const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
  const rows = await db.read<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 't'",
  );
  await db.close();
  return rows[0].n;
};

describe('deleteDatabase', () => {
  const created: string[] = [];
  afterEach(async () => {
    for (const file of created.splice(0)) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(file, { recursive: true });
      } catch {
        // Already deleted by the test, which is the point of most of them.
      }
    }
  });

  const freshFile = () => {
    const file = `delete-${crypto.randomUUID()}`;
    created.push(file);
    return file;
  };

  it('removes a closed database', async () => {
    const file = freshFile();
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();
    expect(await tableCount(file)).toBe(1);

    await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' });

    expect(await tableCount(file)).toBe(0);
  });

  // SQLite's own xDelete is content with a missing file, and this is also what
  // makes the OPFS pass inert once upstream's jDelete is fixed.
  it('succeeds on a database that was never created', async () => {
    await expect(
      deleteDatabase(freshFile(), { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });

  it('is idempotent', async () => {
    const file = freshFile();
    const db = createSQLiteClient(file, { vfs: 'OPFSAdaptiveVFS' });
    await db.write('CREATE TABLE t (a INTEGER)');
    await db.close();

    await deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' });
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });

  it('rejects with INVALID_OPTION when vfs is missing', async () => {
    await expect(
      // @ts-expect-error — the guard exists for JavaScript callers
      deleteDatabase('anything', {}),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('rejects with INVALID_OPTION when the build is not one the VFS supports', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'OPFSAdaptiveVFS', build: 'sync' }),
    ).rejects.toMatchObject({ code: 'INVALID_OPTION' });
  });

  it('resolves without a worker for a memory VFS', async () => {
    await expect(
      deleteDatabase('anything', { vfs: 'MemoryVFS' }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test:browser -- delete`
Expected: FAIL — `src/delete.ts` does not exist.

- [ ] **Step 3: Add the two message shapes**

In `src/types.ts`, add to `ClientMessageData`, after the `open` variant:

```ts
  | {
      type: 'delete';
      callId: number;
      file: string;
      vfs: SQLiteVFS;
      build?: SQLiteBuild;
      wasm?: WasmLocation;
    }
```

and to `WorkerMessageData`:

```ts
  | { type: 'deleted'; callId: number }
```

- [ ] **Step 4: Handle it in the worker**

In `src/worker/worker.ts`, add above the top-level `self.onmessage`:

```ts
/**
 * The database and the two siblings SQLite may leave beside it. The set is
 * upstream's own (`OPFSCoopSyncVFS.js:8`), not a guess: a stale `-journal` next
 * to a deleted database is a hot journal, and recreating a database of that
 * name would have SQLite attempt a rollback from it. On `AccessHandlePoolVFS`
 * each sibling also occupies its own pool slot.
 */
const DB_RELATED_SUFFIXES = ['', '-journal', '-wal'] as const;

/**
 * Removes one OPFS entry if it is there, walking the path's directories.
 * A missing entry is success — which is what makes this pass inert should
 * upstream's `jDelete` start removing the file itself.
 */
const removeOpfsEntry = async (path: string): Promise<void> => {
  const segments = path.split('/').filter(Boolean);
  const name = segments.pop();
  if (!name) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const segment of segments) {
      dir = await dir.getDirectoryHandle(segment);
    }
    await dir.removeEntry(name);
  } catch (error) {
    if ((error as DOMException)?.name === 'NotFoundError') return;
    throw error;
  }
};

/**
 * Deletes a database without opening it.
 *
 * The VFS is instantiated because `jDelete` is the only correct removal on
 * `AccessHandlePoolVFS` — it un-associates the SQLite path and returns the slot
 * to the pool, where deleting the OPFS file by name would match nothing.
 *
 * The second pass exists because two of the seven persistent `jDelete`
 * implementations do not delete: `OPFSCoopSyncVFS` truncates a file it never
 * removes, and is a silent no-op for a database that is not open — which is
 * every database here, since nothing is opened; `OPFSWriteAheadVFS` throws for
 * anything that is not a bound temporary file. Both keep the database at the
 * plain OPFS path, so the remedy is the `removeEntry` the other two OPFS VFS
 * already perform internally. It runs for all four `opfs-path` VFS rather than
 * for an exception list, because it is idempotent and a list would be a second
 * place to update when a VFS is added.
 */
const deleteDatabaseFiles = async (data: {
  file: string;
  vfs: SQLiteVFS;
  build?: SQLiteBuild;
  wasm?: WasmLocation;
}) => {
  const { file, vfs, wasm } = data;
  const build = data.build ?? defaultBuildFor(vfs);

  const { default: factory } = await WA_SQLITE_BUILDS[build]();
  const module = await factory(wasmModuleArg(wasm));
  const vfsModule = (await VFSConfigs[vfs].fs()) as unknown as Record<
    string,
    VFSClass
  >;
  const vfsInstance = (await vfsModule[vfs].create(vfs, module, {
    lockPolicy: 'shared',
  })) as any;

  try {
    for (const suffix of DB_RELATED_SUFFIXES) {
      await vfsInstance.jDelete(`${file}${suffix}`, 0);
    }
  } finally {
    await vfsInstance.close?.();
  }

  if (VFS_CAPABILITIES[vfs].layout === 'opfs-path') {
    for (const suffix of DB_RELATED_SUFFIXES) {
      await removeOpfsEntry(`${file}${suffix}`);
    }
  }
};
```

Add `VFS_CAPABILITIES` to the `'../types'` import in that file.

Then add the case to the top-level `self.onmessage` switch, before `case 'query'`:

```ts
    case 'delete': {
      deleteDatabaseFiles(data)
        .then(() => {
          self.postMessage({ type: 'deleted', callId: 0 });
        })
        .catch((error: unknown) => {
          self.postMessage({
            type: 'error',
            callId: 0,
            message:
              error instanceof Error
                ? error.message
                : `Failed to delete ${data.file}`,
            cause: cloneable(error),
            ...(typeof (error as { code?: unknown })?.code === 'number'
              ? { sqliteCode: (error as { code: number }).code }
              : {}),
          });
        });
      break;
    }
```

- [ ] **Step 5: Write the client function**

Create `src/delete.ts`:

```ts
import { SQLiteError } from './errors';
import { createLocks, initLockName } from './locks';
import { busyFromCode, spawnWorker } from './pool';
import {
  defaultBuildFor,
  RECOMMENDED_VFS,
  type SQLiteBuild,
  type SQLiteVFS,
  VFS_CAPABILITIES,
  type WorkerMessageData,
} from './types';
import { normalizeDatabaseFile, resolveWasmLocation } from './utils';

export type DeleteDatabaseOptions = {
  /**
   * Which VFS holds the database. Required for the same reason it is required
   * on `createSQLiteClient`: a VFS decides where the bytes live, so deleting
   * without naming one deletes in the wrong store — or nowhere, while
   * reporting success.
   */
  vfs: SQLiteVFS;
  /**
   * Which wa-sqlite build to load. It does **not** affect where the database
   * lives; it is here only because a VFS runs solely on the builds it
   * declares, and one of them must be loaded to instantiate the VFS at all.
   * @defaultValue the first build the VFS declares
   */
  build?: SQLiteBuild;
  /**
   * Where the worker fetches its `.wasm`, with the same meaning as on
   * `createSQLiteClient`. A deployment that needs it to open a database needs
   * it to delete one.
   */
  wasmUrl?: string | ((build: SQLiteBuild) => string);
};

/**
 * Deletes a database and the two siblings SQLite may leave beside it.
 *
 * Deleting a database that is not there is success — SQLite's own `xDelete`
 * behaves the same way, and a caller who wanted it gone has got what they
 * asked for.
 *
 * Nothing a VFS keeps for itself is touched: not the IndexedDB store, which is
 * shared by every database that VFS holds on this origin, and not the
 * `AccessHandlePoolVFS` directory, whose files *are* its reusable capacity.
 * The bytes of the named database are freed in both cases.
 *
 * @throws {SQLiteError} `INVALID_OPTION` when `vfs` is missing or the `build`
 *   is not one the VFS supports — synchronously in spirit, as a rejection here.
 * @throws {SQLiteError} `BUSY` when the database is open or being opened, in
 *   this tab or another. A connection already holding its handles cannot be
 *   revoked from here; see the README's Known Limitations.
 */
export const deleteDatabase = async (
  file: string,
  options: DeleteDatabaseOptions,
): Promise<void> => {
  if (!options?.vfs) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `vfs is required. Pass the VFS the database was created with — ${RECOMMENDED_VFS} is the recommended universal choice. A database written through one VFS is not visible through another, so deleting through the wrong one deletes nothing.`,
    );
  }

  const vfs = options.vfs;
  const build = options.build ?? defaultBuildFor(vfs);
  const capability = VFS_CAPABILITIES[vfs];

  if (!(capability.builds as readonly SQLiteBuild[]).includes(build)) {
    throw new SQLiteError(
      'INVALID_OPTION',
      `${vfs} cannot run on the '${build}' build. Supported: ${capability.builds.join(', ')}.`,
    );
  }

  // Nothing was ever persisted, so there is nothing to delete and no worker
  // worth spawning to say so.
  if (capability.layout === 'memory') return;

  const dbFile = normalizeDatabaseFile(file);
  const wasm = resolveWasmLocation(options.wasmUrl, build, location.href);

  const ran = await createLocks().tryWithLock(initLockName(dbFile), () =>
    runDelete({ file: dbFile, vfs, build, wasm }),
  );

  if (!ran) {
    throw new SQLiteError(
      'BUSY',
      `${dbFile} is being opened or deleted elsewhere. Close every client on it, in every tab, and try again.`,
    );
  }
};

const runDelete = (message: {
  file: string;
  vfs: SQLiteVFS;
  build: SQLiteBuild;
  wasm: ReturnType<typeof resolveWasmLocation>;
}): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const worker = spawnWorker(`SQLite delete / ${message.file}`);

    const settle = (error?: SQLiteError) => {
      worker.terminate();
      if (error) reject(error);
      else resolve();
    };

    worker.onmessage = (event: MessageEvent<WorkerMessageData>) => {
      const data = event.data;
      if (data.type === 'deleted') return settle();
      if (data.type === 'error') {
        return settle(
          busyFromCode(data) ??
            new SQLiteError('WORKER_CRASHED', data.message, {
              cause: data.cause,
            }),
        );
      }
    };

    worker.onerror = (event) => {
      settle(
        new SQLiteError(
          'WORKER_CRASHED',
          `worker crashed while deleting ${message.file}: ${(event as ErrorEvent).message ?? ''}`,
        ),
      );
    };

    worker.postMessage({ type: 'delete', callId: 0, ...message });
  });
```

- [ ] **Step 6: Export it**

In `src/index.ts`, add `export * from './delete';` immediately after `export * from './client';`.

- [ ] **Step 7: Run the test**

Run: `pnpm check && npx tsc --noEmit && pnpm test:browser -- delete`
Expected: all seven cases pass.

- [ ] **Step 8: Run everything**

Run: `pnpm test`
Expected: 367 tests pass — 358 at the baseline, +2 from Task 1, +7 here.

- [ ] **Step 9: Commit**

```bash
git add src/types.ts src/worker/worker.ts src/delete.ts src/index.ts tests/browser/delete.test.ts
git commit -m "feat(delete): deleteDatabase, routed through the VFS and finished in OPFS"
```

---

### Task 4: the held-database and never-answers paths

Two ways a delete does not happen, and both must say which one it was rather than hang.

**Files:**
- Modify: `src/delete.ts`
- Test: `tests/browser/delete.test.ts`

**Interfaces:**
- Consumes: `deleteDatabase` (Task 3).
- Produces: no new exports. `DELETE_TIMEOUT` stays module-private.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('deleteDatabase', …)` in `tests/browser/delete.test.ts`:

```ts
  // `navigator.locks` is origin-wide, so this is the same lock a client in
  // another tab would hold while opening. Held here directly, because the point
  // is the lock and not the client that usually takes it.
  it('rejects with BUSY while the init lock is held', async () => {
    const file = freshFile();
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(`bsq:init:${file}`, () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;

    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'BUSY' });

    release.resolve();
  });

  // Falsifiable: make the BUSY path return instead of throwing from inside
  // `tryWithLock`, and the second call finds a lock nobody released.
  it('releases the lock after a rejection, so a retry is possible', async () => {
    const file = freshFile();
    const release = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();

    void navigator.locks.request(`bsq:init:${file}`, () => {
      held.resolve();
      return release.promise;
    });
    await held.promise;
    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).rejects.toMatchObject({ code: 'BUSY' });
    release.resolve();

    await expect(
      deleteDatabase(file, { vfs: 'OPFSAdaptiveVFS' }),
    ).resolves.toBeUndefined();
  });
```

- [ ] **Step 2: Run them**

Run: `pnpm test:browser -- delete`
Expected: the BUSY cases already pass from Task 3's lock, which is the point — they pin behaviour Task 3 introduced without asserting. The retry case may reveal a lock that is not released on the rejection path.

- [ ] **Step 3: Add the deadline**

In `src/delete.ts`, above `runDelete`:

```ts
/**
 * How long a delete may take before the worker is presumed unable to answer.
 * Matches `openTimeout`'s default, because the failure it catches is the same
 * one: a VFS that cannot acquire what it needs — `AccessHandlePoolVFS` whose
 * six slots are held elsewhere reaches neither success nor error. Not a public
 * option: a caller has nothing useful to tune here, and a delete that takes
 * thirty seconds has already failed.
 */
const DELETE_TIMEOUT = 30_000;
```

and inside `runDelete`, immediately after `const worker = …`:

```ts
    const timer = setTimeout(() => {
      settle(
        new SQLiteError(
          'TIMEOUT',
          `deleting ${message.file} timed out after ${DELETE_TIMEOUT} ms. The database is most likely held open by another client or tab.`,
        ),
      );
    }, DELETE_TIMEOUT);
```

and change `settle` so the timer never outlives the worker:

```ts
    const settle = (error?: SQLiteError) => {
      clearTimeout(timer);
      worker.terminate();
      if (error) reject(error);
      else resolve();
    };
```

`settle` is referenced by the timer and the timer by `settle`; declare `const timer` before `const settle` and read it inside the closure, which runs only after both exist.

**The deadline itself carries no test, deliberately.** A case that waits thirty seconds to prove one line costs more wall-clock in every future run than the line is worth, and shortening it would mean making the constant injectable — public surface for a test. Its falsifiable check is manual and takes a minute: lower `DELETE_TIMEOUT` to `100`, hold `AccessHandlePoolVFS`'s six slots with a live client, and watch the delete reject with `TIMEOUT` instead of hanging. Record that you ran it in the commit message.

- [ ] **Step 4: Run the tests**

Run: `pnpm check && npx tsc --noEmit && pnpm test:browser -- delete`
Expected: all nine cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/delete.ts tests/browser/delete.test.ts
git commit -m "feat(delete): a held database says BUSY, a silent one says TIMEOUT"
```

---

### Task 5: the conformance invariant

The suite already executes every declared VFS. This is where deletion is proved on all of them at once, and it is what will report at the next vendored bump whether upstream fixed its `jDelete` or whether a VFS changed its layout.

**Files:**
- Modify: `tests/conformance/invariants.test.ts`

**Interfaces:**
- Consumes: `deleteDatabase` (Tasks 3-4), `VFS_CAPABILITIES[vfs].layout` (Task 1), `conformanceClient`, `missingHere`, `ALL_VFS` (`tests/conformance/helpers.ts`).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/conformance/invariants.test.ts`, and add `deleteDatabase` to the imports from `'../../src/delete'`:

```ts
/**
 * A database that is deleted is gone, on every VFS that persists one.
 *
 * Asserted through a fresh client rather than through OPFS: half the VFS keep
 * nothing at that name, and `AccessHandlePoolVFS` keeps a slot file whose name
 * is unrelated to the database's.
 *
 * Falsifiable, and worth doing by hand once: change `OPFSCoopSyncVFS`'s
 * `layout` away from `'opfs-path'` and this must go red for that VFS. Only
 * `jDelete` would then run, and `OPFSCoopSyncVFS.jDelete` truncates a file it
 * never removes — and does nothing at all for a database that is not open,
 * which is every database here. A step whose removal leaves the suite green is
 * a step nothing depends on.
 */
describe('invariant 7 — a deleted database is gone', () => {
  for (const vfs of ALL_VFS) {
    if (VFS_CAPABILITIES[vfs].layout === 'memory') {
      it.skip(`${vfs} — skipped, nothing persists to delete`, () => {});
      continue;
    }
    const missing = missingHere(vfs);
    if (missing) {
      it.skip(`${vfs} — skipped, no ${missing} in this browser`, () => {});
      continue;
    }
    it(`${vfs}`, async () => {
      const { file, db } = conformanceClient(vfs);
      await db.write('CREATE TABLE t (a INTEGER)');
      await db.write('INSERT INTO t VALUES (1)');
      await db.close();

      await deleteDatabase(file, { vfs });

      const reopened = createReopened(file, vfs);
      const rows = await reopened.read<{ n: number }>(
        "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 't'",
      );
      expect(rows[0].n).toBe(0);
      await reopened.close();
    });
  }
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test:conformance`
Expected: seven persistent VFS pass, two memory VFS skip with their reason. Any VFS that fails here is a finding, not a test defect — record which, and stop rather than adapting the assertion.

- [ ] **Step 3: Record the count**

Run: `pnpm test:conformance 2>&1 | grep -E '"(passedTests|skippedTests)"'`
Expected: the baseline moves from 66/10 to 73/12. Write the observed numbers into the commit message.

- [ ] **Step 4: Commit**

```bash
git add tests/conformance/invariants.test.ts
git commit -m "test(conformance): a deleted database is gone, on every VFS that keeps one"
```

---

### Task 6: documentation

**Files:**
- Modify: `README.md` (Advanced section; Known Limitations)
- Modify: `CHANGELOG.md` (unreleased, Added)

**Interfaces:**
- Consumes: the shipped surface.
- Produces: nothing.

- [ ] **Step 1: README — the method**

Add a `### deleteDatabase` subsection under `## Advanced`, after `### output`:

```markdown
### deleteDatabase

Removes a database and the `-journal` / `-wal` files SQLite may have left beside it. The database must not be open, in this tab or any other.

```typescript
import { deleteDatabase } from 'browser-sqlite';

await deleteDatabase('myapp.sqlite', { vfs: 'OPFSAdaptiveVFS' });
```

`vfs` is required and must be the VFS the database was created with: a database written through one VFS is not visible through another, so deleting through the wrong one deletes nothing and reports success. `build` and `wasmUrl` are accepted with the same meaning as on `createSQLiteClient`.

Deleting a database that does not exist is not an error.

What a VFS keeps for itself is left alone — the IndexedDB store shared by every database that VFS holds on this origin, and the `AccessHandlePoolVFS` directory whose files are its reusable capacity. The deleted database's own bytes are freed in both cases.

Throws `SQLiteError` with code `BUSY` when the database is open or being opened, and `TIMEOUT` when the VFS cannot answer within 30 seconds — most often the same cause.
```

- [ ] **Step 2: README — Known Limitations**

Add one entry to `## Known Limitations`, in the existing style of that section:

```markdown
- **A database that is open cannot be deleted**, in this tab or another. `deleteDatabase` takes the same origin-wide lock a client takes while opening, which prevents an open from interleaving with a delete, and reports `BUSY` rather than deleting under a live connection. A connection that already holds its handles cannot be revoked from this library — close every client on the database first.
```

- [ ] **Step 3: CHANGELOG**

Add at the top of the `### Added` section, above the `wasmUrl` entry:

```markdown
- **`deleteDatabase(file, { vfs })`** — a supported way to remove a database and
  the `-journal` / `-wal` files beside it, on every VFS that persists one. On
  `AccessHandlePoolVFS` it is the only correct removal: it returns the pool slot,
  where deleting the OPFS file by name would match nothing. Storage a VFS keeps
  for itself is left alone — the shared IndexedDB store and the pool directory —
  while the named database's bytes are freed. Deleting a database that is not
  there is not an error; deleting one that is open reports `BUSY`.
```

- [ ] **Step 4: Verify the whole baseline**

Run: `pnpm check && npx tsc --noEmit && pnpm build && pnpm test && pnpm test:conformance && node scripts/consumer-smoke.mjs`
Expected: 369 tests, conformance 73/12, smoke 24/24, build clean.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: deleteDatabase, and the open-database limit it cannot lift"
```

---

## Self-Review

**Spec coverage.** §1 goal → Tasks 3-5. §2 non-goals → Global Constraints (no container removed, bench untouched). D1/D2 → Task 3 Step 4 deletes only the named files; no task removes a container. D3 → Task 3 Step 4's second pass, applied to all `opfs-path`. D4 → out of this plan by design; the conformance invariant (Task 5) is what will detect the fix landing. D5 → Task 3 Step 5, a standalone function. D6 → Task 3 Step 5's two throws and the `build` default; `wasmUrl` threaded in Steps 3-5. D7 → Task 3 Step 1's "never created" and "idempotent" cases, plus `removeOpfsEntry`'s `NotFoundError` branch. D8 → `DB_RELATED_SUFFIXES`. D9 → Task 3 Step 5's `tryWithLock`, pinned by Task 4. D10 → Global Constraints; no task touches `SQLiteErrorCode`. §4 surface → Task 3. §5 → the comments carrying it are in Task 3 Step 4. §6 mechanism → Task 3 Steps 4-5, `spawnWorker` from Task 2. §7 `layout` → Task 1. §8 verification → Tasks 3, 4, 5 and Task 6 Step 4. §10 documentation → Task 6. §11 left-open items → no task; they are recorded, not built.

**Placeholders.** None: every code step carries its code, every run step carries its command and expected output.

**Type consistency.** `VFSLayout` is defined in Task 1 and read in Tasks 3 and 5. `spawnWorker(name: string): Worker` and `busyFromCode` are produced by Task 2 and consumed by Task 3. `DeleteDatabaseOptions` is defined once, in Task 3. The message `{ type: 'delete', callId, file, vfs, build?, wasm? }` is declared in Task 3 Step 3, posted in Step 5 and read in Step 4 with the same field names. `{ type: 'deleted', callId }` likewise. `DB_RELATED_SUFFIXES` is spelled identically in the worker and in the README's prose.

**One deviation from the spec, deliberate and flagged:** the spec's §4 error list does not mention `TIMEOUT`. Task 4 adds a fixed 30-second deadline because `AccessHandlePoolVFS` whose slots are held elsewhere reaches neither success nor failure, and an unbounded hang is worse than either. It introduces no new error code — `TIMEOUT` is already in the union — and no new public option.
