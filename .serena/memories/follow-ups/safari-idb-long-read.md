# Follow-up — Safari 27: a read waited out another worker's long statement on `IDBBatchAtomicVFS/async` (2026-11-15)

**Status: OPEN** — seen once, not reproduced, cause unknown.

Part of `mem:follow-ups`.

- **Seen:** macOS 27 matrix of `ci/macos-matrix-bound` `88beee28` (run 43701023260, cells one at a time), `safari · IDBBatchAtomicVFS/async`, `idb-long-read.test.ts` › "IDBBatchAtomicVFS during a long statement > serves a read from another worker without a signal": `expected 'long' to be 'read'`. The same test was green on Safari in the earlier macOS 27 matrices (5.3 s on `14af753e`'s retried Safari cell).
- **Not a faster long statement:** the test took 5.1 s, as its green runs; so the self-join (`SELECT count(*) FROM t a JOIN t b ON a.id < b.id`, 6 000 rows) lasted as long, and the read on the other worker (`poolSize: 2`) was served only after it — the serialisation the test guards: `IDBBatchAtomicVFS.jLock` holds a readwrite IndexedDB transaction from SHARED, which commits only once the long statement's worker yields to its event loop; the worker installs a yielding progress handler on every statement (`yieldsDuringStatements`, `fix/idb-long-read`, 2026-09-14, `mem:vfs`).
- **Its guard held:** `theQueryIsRunning(db, LONG)` before the race, and the long statement not settled at the race's start (`longSettled` false).
- **Unknown:** whether the yield happened on Safari 27 that time (how the progress handler yields: a timer? Safari 27 runs an idle page's timers at 1 Hz, SAFARI27-TIMER-1HZ, `mem:measurements/ci-runners` — but the yield is in the worker, whose timers ran at 5 ms there), or whether Safari's IndexedDB queued the second connection's transaction behind the first's anyway; how often.
- **Next:** read how the progress handler yields (`src/worker/`), loop the test on Safari 27 (a spike workflow on `xcode-27`), and, if it reproduces, trace the readwrite transaction's commit time against the yields.
