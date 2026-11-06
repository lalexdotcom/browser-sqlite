# Follow-up — `deleteDatabase` fails with an IndexedDB `UnknownError` on Windows Firefox `IDBMirrorVFS/jspi` (2026-11-06)

**Status: OPEN** — first sighting, being diagnosed (user, 2026-11-06: no matrix red is ignored, `mem:conventions`).

Part of `mem:follow-ups`, opened 2026-11-06 from the Windows matrix of `main` after `fix/delete-without-vfs` (run 42215479058, job 127885061511, cell `IDBMirrorVFS/jspi`, `firefox__IDBMirrorVFS__jspi`).

**What failed.** `tx-savepoint.test.ts` › "the savepoint asks SQLite (spec 2026-10-26, § Transactions) > undoes a tx.run() write aborted by its own signal while it runs, and goes on" — not the test's own assertions: the `cleanUp` that `createTestClient` registers with `onTestFinished` (`tests/browser/helpers/index.ts`), so it ran AFTER the test, on the test's own database — after a `BIG_INSERT` aborted by its signal at 30 ms, the transaction's commit and `db.close()` — and whose `deleteDatabase` rejected `WORKER_CRASHED: The operation failed for reasons unrelated to the database itself and not covered by any other error code.`, caused by `UnknownError` (`result` 2154168321 = `0x80660001`, `NS_ERROR_DOM_INDEXEDDB_UNKNOWN_ERR`), reported by the delete worker's `error` reply (`startupError`). No retry (not a Vitest timeout). The same cell was green on the branch's Windows matrix hours before (run 42206052683); no earlier sighting in these memories.

**Not the fix's path:** `IDBMirrorVFS` has no folder, so `deleteDatabaseFiles` still creates the VFS, probes with `open_v2`, `jDelete`s and closes it — unchanged by `fix/delete-without-vfs`.

**Hypothesis (Claude, 2026-11-06, not verified):** the client worker's `closeIdbVfs` waits at most `IDB_CLOSE_MS` (2 s, a library bound no `BSQ_TIME_SCALE` stretches) for `IDBMirrorVFS`'s transactions; after the aborted `BIG_INSERT`, on Windows Firefox, that close took longer, the worker was terminated mid-IndexedDB-transaction, and the delete worker's next IndexedDB connection met the `UnknownError`.

**Unknown:** which step of the delete worker threw (VFS creation opening IndexedDB, the probe, `jDelete`, `close`); whether the client's `closeIdbVfs` hit its 2 s bound; how often.
