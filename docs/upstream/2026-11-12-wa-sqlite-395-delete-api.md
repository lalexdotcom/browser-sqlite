# wa-sqlite #395 — a way to delete a database through its VFS

*2026-11-12 — read on wa-sqlite `v1.2.0` (`46317457`)*

[d395]: https://github.com/rhashimoto/wa-sqlite/discussions/395

**Why this is here.** This library's `deleteDatabase()` cannot ask the VFS to delete a database: neither SQLite nor wa-sqlite has that operation. So the library keeps its own copy of each VFS's storage layout — `DATABASE_FILE_SUFFIXES` and `VFS_CAPABILITIES[vfs].folder`/`extraFileSuffixes` — and, on the VFS with a folder, removes the OPFS entries itself (`deleteFolderDatabase` in `src/worker/worker.ts`, without SQLite or a VFS instance since `fix/delete-without-vfs`, 2026-11-06). That copy has already gone stale once: `OPFSWriteAheadVFS`'s `-wa0`/`-wa1` were left behind (DELETE-WA, `mem:measurements/cross-tab-and-delete`). And going through a VFS instance instead cost `OPFSCoopSyncVFS` 5 s median, up to 37 s, on Windows Firefox (DELETE-VFS-CREATE). The question to wa-sqlite: should the VFS itself know how to delete a database?

## What was read on `v1.2.0`

**`jDelete()` is for what SQLite asks, nothing more.** SQLite calls `xDelete()` for journals and temporary files, never for a main database. `OPFSCoopSyncVFS.jDelete()` truncates the file and keeps it; `OPFSWriteAheadVFS.jDelete()` throws `unexpected file deletion` for anything but its own temporary files.

**Runtime-named resources.** Three VFS create names at runtime:

- `OPFSCoopSyncVFS`: a `.ahp-<random>` directory per instance, under a Web Lock of the same name, swept by a later instance's startup when the lock is free;
- `OPFSWriteAheadVFS`: a `.session-<random>` directory per instance, same pattern;
- `AccessHandlePoolVFS`: pool files named at random by `addCapacity()`; the SQLite path a file holds is only in its 512-byte header, and `jDelete(path)` clears that header, returning the file to the pool.

The first two belong to an instance, not to a database. The third is why a list of resources cannot serve every VFS.

**What creating an instance does.**

| VFS | `create()` |
|---|---|
| `OPFSAdaptiveVFS`, `OPFSAnyContextVFS`, `OPFSPermutedVFS` | nothing beyond the base class |
| `IDBBatchAtomicVFS`, `IDBMirrorVFS` | opens the IndexedDB connection |
| `OPFSCoopSyncVFS` | the `.ahp-*` sweep, its own directory, access handles on 10 temporary files (`DEFAULT_TEMPORARY_FILES`, a constant) |
| `OPFSWriteAheadVFS` | the `.session-*` sweep, its own directory, access handles on `nTmpFiles` files (an option) |
| `AccessHandlePoolVFS` | exclusive access handles on every pool file |

The temporary files are taken up front because `jOpen` is synchronous on the `sync` build and cannot create an access handle when SQLite asks for one. Every constructor also takes the WebAssembly module, which the base class only stores.

## Posted upstream

Discussion [#395][d395], category Ideas, opened 2026-11-12. The body, validated by the user, starts from the need (an application deleting a database its VFS stores, with nothing to call), proposes a deletion method every VFS implements with the same signature, explains why a list of a database's resources was set aside (`AccessHandlePoolVFS`), and leaves the shape open: a static method, which pays no instance setup, or an instance method, which `AccessHandlePoolVFS` needs. It asks whether this would be a useful addition and which shape fits best.

Deliberately left out (user): no PR offered until the idea and its shape are agreed; no measurements, no cost of the instance setup beyond naming it; the rest left to come out of the discussion. It does not cite this library.

## What stays ours

- `DATABASE_FILE_SUFFIXES`, `VFS_CAPABILITIES[vfs].folder`/`extraFileSuffixes` and `deleteFolderDatabase`, until wa-sqlite offers a deletion; then `deleteDatabase()` calls it, and the copy of each layout goes.
- If the method is an instance method only: weigh it against DELETE-VFS-CREATE before switching `OPFSCoopSyncVFS` to it.
