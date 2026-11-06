# Follow-up — `deleteDatabase` fails with an IndexedDB `UnknownError` on Windows Firefox `IDBMirrorVFS/jspi` (2026-11-06)

**Status: OPEN** — first sighting; not reproduced in a spike of 440 rounds (below), the 2 s close-bound hypothesis refuted; the next step is the user's call (user, 2026-11-06: no matrix red is ignored, `mem:conventions`).

Part of `mem:follow-ups`, opened 2026-11-06 from the Windows matrix of `main` after `fix/delete-without-vfs` (run 42215479058, job 127885061511, cell `IDBMirrorVFS/jspi`, `firefox__IDBMirrorVFS__jspi`).

**What failed.** `tx-savepoint.test.ts` › "the savepoint asks SQLite (spec 2026-10-26, § Transactions) > undoes a tx.run() write aborted by its own signal while it runs, and goes on" — not the test's own assertions: the `cleanUp` that `createTestClient` registers with `onTestFinished` (`tests/browser/helpers/index.ts`), so it ran AFTER the test, on the test's own database — after a `BIG_INSERT` aborted by its signal at 30 ms, the transaction's commit and `db.close()` — and whose `deleteDatabase` rejected `WORKER_CRASHED: The operation failed for reasons unrelated to the database itself and not covered by any other error code.`, caused by `UnknownError` (`result` 2154168321 = `0x80660001`, `NS_ERROR_DOM_INDEXEDDB_UNKNOWN_ERR`), reported by the delete worker's `error` reply (`startupError`). No retry (not a Vitest timeout). The same cell was green on the branch's Windows matrix hours before (run 42206052683); no earlier sighting in these memories.

**Not the fix's path:** `IDBMirrorVFS` has no folder, so `deleteDatabaseFiles` still creates the VFS, probes with `open_v2`, `jDelete`s and closes it — unchanged by `fix/delete-without-vfs`.

**Hypothesis (Claude, 2026-11-06, not verified):** the client worker's `closeIdbVfs` waits at most `IDB_CLOSE_MS` (2 s, a library bound no `BSQ_TIME_SCALE` stretches) for `IDBMirrorVFS`'s transactions; after the aborted `BIG_INSERT`, on Windows Firefox, that close took longer, the worker was terminated mid-IndexedDB-transaction, and the delete worker's next IndexedDB connection met the `UnknownError`.

**Unknown:** which step of the delete worker threw (VFS creation opening IndexedDB, the probe, `jDelete`, `close`); how often.

**IDB-DELETE-SPIKE (2026-11-06, GitHub `windows-latest`, Firefox 155, `BSQ_TIME_SCALE=4`).** Throwaway branch `spike/idb-unknown-error-windows` (`4a4e60c5`; remote deleted): the client worker traced `closeIdbVfs`'s outcome and duration, the delete worker the step it threw at; a test looped the red test's shape (`BIG_INSERT` aborted at 30 ms in a transaction, commit, `close()`, `deleteDatabase`) and a plain control (no abort), on `IDBMirrorVFS/jspi`, `IDBMirrorVFS/async` and `IDBBatchAtomicVFS/jspi` at once. Runs 42238639417 (`IDBMirrorVFS/jspi` lost: three test builds at once crashed Rspack in its shared cache) and 42239589365 (started 90 s apart, `IDBMirrorVFS/jspi` 80 rounds per shape).
- **`closeIdbVfs` never reached its 2 s bound: closed in 0-2 ms in all 440 rounds**, aborted or not — the hypothesis above is refuted.
- **No `UnknownError` in 240 aborted rounds and 200 plain ones.** The aborted transaction took 1.1-2.3 s median (max 3.1 s), the delete 0.13-0.45 s median (max 4.8 s).
- One delete failed `WORKER_CRASHED: CompileError … failed to match magic number` (`IDBMirrorVFS/async`, round 25): the delete worker's `.wasm` was read while the third process rebuilt `tests/build/` (its `built in` lines 0.1 s either side). An artefact of the spike's independent Vitest processes; the planner builds once for all its processes (`BSQ_TEST_BUILT`, `scripts/parallel.ts`), so the matrix is not exposed.

**Options left (Claude, not decided):** have the delete worker's error name the step it was at (as a client's boot stages do), so the next sighting says where; look for what makes Firefox's IndexedDB answer `UnknownError` on Windows; a retry only once a cause is known.
