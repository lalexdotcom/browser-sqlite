# `deleteDatabase` — design

**Status:** approved 2026-08-27, not yet planned.
**Backlog item:** `DELETE-1` in `mem:follow-ups`, which `RESIDUE-1` was folded into.

Every claim about a VFS below was read out of the vendored sources and is cited. Nothing
here is inferred from a VFS's declaration — that mistake is what `OPFSWriteAheadVFS`'s
`requires` cost this project on 2026-08-27, and it is the mistake this document is most
exposed to repeating.

## 1. What has no answer today

The library cannot delete a database, and a consumer has no supported way to remove one.
Every persistent VFS wa-sqlite ships implements `jDelete`, but the worker holds the VFS
instance and nothing routes to it. For `AccessHandlePoolVFS` this is not merely
inconvenient: `jDelete` is the **only** correct removal, because deleting the OPFS file by
name matches nothing and frees no slot.

The gap has a second, sharper consequence. A database left behind occupies storage the
consumer believes they released, and on `AccessHandlePoolVFS` it occupies one of six pool
slots — which is exactly how six-slot exhaustion produced a bare `sqlite3_open_v2` failure
with no message during the 2026-08 campaigns.

## 2. Non-goals

- **Reclaiming a VFS's storage container.** Not the IndexedDB store, not the
  `AccessHandlePoolVFS` directory. §3 D2 records why.
- **A `deleteStorage(vfs)`-style destructive operation.** Its only correct use is rare and
  its incorrect use is irreversible.
- **Replacing the benchmark page's `sweepBeforeRun`.** §9 records why it cannot.
- **Revoking a handle held by another tab.** Nothing at this layer can.
- **Reading upstream's IndexedDB schema or `AccessHandlePoolVFS`'s on-disk header.**

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Delete the database, never the container** | `jDelete` already frees the bytes everywhere it works. `IDBBatchAtomicVFS.jDelete` deletes the whole block range for the path plus its metadata row (`IDBBatchAtomicVFS.js:119-128`). What survives is an empty shell — an IndexedDB store shared by every database that VFS holds on the origin, or a pool directory whose files *are* reusable capacity. Destroying either would take a neighbour's data. |
| D2 | **No emptiness check to reclaim a container** | The cost is not uniform and is highest where it would matter. Emptiness for the IndexedDB pair means reading two different private schemas — `blocks`/`metadata` keyed `['path','offset','version']` and `name` for `IDBBatchAtomicVFS.js:599-606`, `blocks`/`tx` keyed `['path','offset']` and `['path','txId']` for `IDBMirrorVFS.js:97-98` — where a renamed store makes the probe report "empty" and delete a populated container. For `AccessHandlePoolVFS` it means parsing a 512-byte header with a digest in each of six slot files (`AccessHandlePoolVFS.js:9-14`), since the directory holds `DEFAULT_CAPACITY = 6` files by design even when it holds no database. And `indexedDB.deleteDatabase()` waits while any connection is open — the VFS holds one for the client's lifetime, and another tab's cannot be closed from here. |
| D3 | **Route to `jDelete`, then remove the OPFS entry ourselves on every `opfs-path` VFS** | Two of seven persistent VFS do not delete. See §5. A success reported over an intact file is the worst failure this API can have. The removal is applied to all four `opfs-path` VFS rather than to the two that need it: it is idempotent, so the two that do not need it pay one `NotFoundError`, and an exception list would be a second place to update when a VFS is added. |
| D4 | **Fix both upstream in `patches/`, but never depend on it** | The channel exists — `patches/wa-sqlite@1.1.1.patch` carries the ANYCONTEXT-1 fix and its PR is pushed. Both `jDelete` defects harm every consumer, not only us. D3 is written to become inert when the fix lands rather than to conflict with it (§6). |
| D5 | **A standalone exported function, not a client method** | Deletion is a lifecycle operation on a file. The likeliest caller has no client — the database was left by an earlier session or an earlier version. A method would force a consumer to spawn a pool of workers in order to destroy something, and would leave a live client bound to a file that no longer exists. |
| D6 | **`vfs` required, `build` optional** | A VFS decides where the bytes live, so deleting without naming it deletes in the wrong place, or nowhere while reporting success — the same reasoning that made `vfs` required on `createSQLiteClient`. `build` does **not** affect location: it selects the `.wasm` flavour, and the VFS's JavaScript is identical across all three. It is optional only because a VFS runs solely on the builds it declares, so a compatible one must be loaded to instantiate it at all. |
| D7 | **Absence is success** | SQLite's own `xDelete` is content with a missing file. Idempotence is also what makes D3 inert after D4. |
| D8 | **Delete `['', '-journal', '-wal']`, not just the database** | A stale `-journal` beside a deleted database is a hot journal: recreate a database of the same name and SQLite may attempt rollback from it. This is a correctness requirement, not tidiness. The suffix set is upstream's own (`OPFSCoopSyncVFS.js:8`), not ours to guess. On `AccessHandlePoolVFS` each sibling occupies its own slot, so deleting the database alone leaves the pool one short. |
| D9 | **Take `initLockName(file)` exclusively, `ifAvailable`** | `navigator.locks` is origin-wide, so this serialises against any cooperating client's open in any tab. It closes the interleave window; it cannot reach a connection already holding its handles. That residue becomes a named error instead of a platform exception. |
| D10 | **No new `SQLiteErrorCode`** | `INVALID_OPTION` covers validation and `BUSY` already covers `SQLITE_BUSY`/`SQLITE_LOCKED`, which is what a held database is. |

## 4. Public surface

```ts
export const deleteDatabase = (
  file: string,
  options: { vfs: SQLiteVFS; build?: SQLiteBuild },
): Promise<void>;
```

Exported from `src/index.ts`, implemented in a new `src/delete.ts` — `client.ts` is already
large and this shares none of its state.

`file` goes through `normalizeDatabaseFile`, the single definition of database identity used
by the open call, the VFS, the epoch registry and every lock name. A caller who deletes
`'/data/app.db'` and a caller who created `'data/app.db'` must reach the same bytes.

The two synchronous validations mirror `createSQLiteClient` exactly, including their
messages' shape: `vfs` missing, and `build` not among `VFS_CAPABILITIES[vfs].builds`.

Resolves on `void`. It does not report whether anything was there — see D7.

## 5. What each VFS actually does

Read from the vendored sources on 2026-08-27. This table is the reason D3 exists.

| VFS | `jDelete` | Enough? |
|---|---|---|
| `OPFSAdaptiveVFS`, `OPFSAnyContextVFS` | `removeEntry` on the file (`OPFSAdaptiveVFS.js:136-150`, `OPFSAnyContextVFS.js:89-103`) | Yes |
| `AccessHandlePoolVFS` | Un-associates the path and truncates the slot to `HEADER_OFFSET_DATA`, returning it to the pool (`AccessHandlePoolVFS.js:450-457`, `:379-404`) | Yes — and it is the only correct removal |
| `IDBBatchAtomicVFS` | Deletes the block range and the metadata row (`:119-128`) | Yes |
| `IDBMirrorVFS` | `#deleteFile` on the path (`:218-231`) | Yes |
| `OPFSCoopSyncVFS` | **Truncates to 0 and forgets the path; never removes the file** (`:215-231`) | **No** |
| `OPFSWriteAheadVFS` | **Throws for anything that is not a bound temporary file** (`:195-208`) | **No** |

Two failures, and both bite in the normal case rather than at an edge.

**`OPFSCoopSyncVFS` is a silent no-op for an unopened database.** It truncates
`persistentFiles.get(path)` or falls back to `boundAccessHandles.get(path)?.truncate(0)`.
Both maps are populated only by `jOpen` (`:50-53`, `:115-200`). Deleting a database that is
not open in that instance — which is precisely what `deleteDatabase` does, since it loads
the VFS without opening anything — passes through two `undefined`, the optional call
evaporates, and only `accessiblePaths.delete(path)` runs. The VFS forgets the path; the file
keeps its bytes; `SQLITE_OK` is returned.

**`OPFSWriteAheadVFS` cannot delete a database at all.** Its `jDelete` handles bound
temporary files and throws otherwise, which surfaces as `SQLITE_IOERR_DELETE`. A main
database is never a bound temporary file.

**Both keep the database at the plain OPFS path**, exactly like `OPFSAdaptiveVFS` and
`OPFSAnyContextVFS` (`OPFSWriteAheadVFS.js:896-903`). `.wa-sqlite/` holds only
`.session-<random>` directories for temporary files, and upstream already sweeps stale ones
at construction under a lock (`:71-86`). So the remedy for both is the same `removeEntry`
the other two VFS already perform internally — no private constant, no private format.

## 6. Mechanism

1. Validate the options synchronously (§4).
2. `tryWithLock(initLockName(file), …)` — `src/locks.ts:108-114` already requests exclusive
   with `ifAvailable: true` and reports failure rather than waiting. A `false` return becomes
   `SQLiteError('BUSY')` naming the file.
3. Spawn one worker; post `{ type: 'delete', callId, file, vfs, build }`.
4. In the worker: load the build, instantiate the VFS, **open nothing**. Call `jDelete` for
   each of `['', '-journal', '-wal']`.
5. In the worker, when `VFS_CAPABILITIES[vfs].layout === 'opfs-path'`: walk the path
   components from the OPFS root and `removeEntry` each of the same three names. A
   `NotFoundError` is success.
6. Terminate the worker; release the lock; resolve.

Step 5 runs for all four `opfs-path` VFS, not only the two that need it. On
`OPFSAdaptiveVFS` and `OPFSAnyContextVFS` the file is already gone by then and the call
costs one `NotFoundError`; the alternative is an exception list that would have to be
revisited every time a VFS is added.

Step 5 is D3, and it is written to be **idempotent, never conditional on the VFS's
version**. After D4 lands upstream, `jDelete` removes the file first, step 5 finds nothing,
and the `NotFoundError` path makes it a no-op. Nothing needs deleting from our side when the
vendored version is bumped — the conformance suite (§8) is what confirms it.

The two memory VFS have nothing to delete and no worker is spawned: the call resolves
immediately.

### `spawnWorker`

`new Worker(new URL('./worker/worker.js', import.meta.url), …)` must remain **one literal
expression** or bundlers stop following it. It is extracted from `createPoolWorker` into a
`spawnWorker(name)` helper in `src/pool.ts` and used by both callers. One construction site,
two consumers.

`ClientMessageData` gains a `delete` variant and `SQLWorkerResultData` gains its result,
beside `open`.

## 7. The `layout` declaration

`storage` does not answer the question step 5 asks. `AccessHandlePoolVFS` is
`storage: 'opfs'` yet keeps opaque slots, so "is the database an OPFS entry at its path"
cannot be derived from it.

`VFSCapability` gains a required field:

```ts
readonly layout: 'opfs-path' | 'opfs-pool' | 'idb-store' | 'memory';
```

Required, so all nine entries must declare it and the compiler enforces it — the same
discipline every other field in that table carries. Today: `opfs-path` for
`OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSCoopSyncVFS`, `OPFSWriteAheadVFS`;
`opfs-pool` for `AccessHandlePoolVFS`; `idb-store` for `IDBBatchAtomicVFS` and
`IDBMirrorVFS`; `memory` for the two memory VFS.

This is the minimal useful form of "a VFS should declare the storage it owns", which
`mem:follow-ups` recorded as the library-side half of RESIDUE-1. It states a truth about the
VFS rather than a permission for one function, which is why it is preferred over a boolean
scoped to this feature.

## 8. Verification

- **Conformance** — the suite already executes every declared `(vfs, build)` pair, so a
  deletion invariant there covers all of them at once: create, close, delete, then assert the
  database is gone by the VFS's own means. This is the check that will report, at the next
  vendored bump, whether D4 landed or whether a VFS changed its layout.
- **Browser** — a database held open is refused with `BUSY`, and the lock is released
  afterwards.
- **Unit** — option validation, and normalization agreement between `deleteDatabase` and
  `createSQLiteClient` for the same spellings of one name.
- **A falsifiable check for step 5**, worth writing as such: change
  `OPFSCoopSyncVFS`'s `layout` away from `'opfs-path'` and the deletion invariant must go
  red. Only `jDelete` would then run, and §5 establishes that it is a no-op there. A step
  whose removal leaves the suite green is a step nothing depends on.

## 9. Why this does not replace the benchmark page's cleanup

`sweepBeforeRun` runs **before** a bench because the residue it exists for comes from runs
that never finished — interrupted, tab closed, page reloaded. A deletion API runs only when
a run completes, which is exactly when there is no problem. It cannot replace a
start-of-run sweep.

It could retire the end-of-run halves, `cleanupIdb()` and `cleanupOpfsResidue()`, and only
partly: it would not see `OPFSCoopSyncVFS`'s `.ahp-<random>` temporary directories
(`OPFSCoopSyncVFS.js:89`), nor the IndexedDB shells D1 deliberately leaves.

There is also a reason of principle. The page measures the VFS this library exposes; making
its cleanliness depend on the feature it validates closes the loop at the wrong point — a
defective `deleteDatabase` would leave the bench dirty *and* unable to show it.

## 10. Documentation owed

- A README section for the function, stating that `vfs` is required and why.
- A **Known Limitations** entry: a database open in this tab or another cannot be deleted;
  the lock closes the interleave window but not that case; nothing at this layer can revoke
  a handle held elsewhere.
- The `CHANGELOG.md` unreleased section.

## 11. Left open deliberately

- **`.ahp-<random>` directories** (`OPFSCoopSyncVFS`) cannot be reached by declaration —
  their names are random. Only a before/after difference sees them, which a library cannot
  safely do on an origin it shares with the application.
- **The benchmark page's sweep derives container names by class name**
  (`scripts/bench/html/index.html:824-827`), so it sees neither `.wa-sqlite` nor `.ahp-*`.
  RESIDUE-1 was closed on a coverage that leaves both out. Recorded here because the fact was
  established while designing this; it is a bench matter, not a library one.
