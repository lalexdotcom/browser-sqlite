# wa-sqlite #384 — `IDBBatchAtomicVFS.close()` returns before its last transaction finishes

*2026-10-21 — measured on Chrome 153 and Firefox 155 (container, Linux); the Safari side measured on Safari 26.6.2 (GitHub `macos-latest`) and 27.0.1 (the user's Mac)*

[pr384]: https://github.com/rhashimoto/wa-sqlite/pull/384
[webkit324094]: https://bugs.webkit.org/show_bug.cgi?id=324094

**Why this is here.** On Safari, a worker ended before its last IndexedDB transaction fired `complete` can leave its connection open for the life of the Safari process, so `indexedDB.deleteDatabase` and upgrades block ([WebKit 324094][webkit324094]; SAFARI-IDB-STRAND, `mem:measurements/test-browsers`). This library terminates a worker on its last reply. Its delete worker answered with the `jAccess` barrier's readonly transaction still live, and its pool's `close` could answer with a readwrite one, which stranded 45 of 75 pair files on `IDBBatchAtomicVFS`. The library worked around it in the worker: it wraps `IDBDatabase.prototype.transaction` and waits for every transaction before those replies (`src/worker/idb-transactions.ts`, merged 2026-10-21). This PR does the close-path part where it belongs, in the VFS.

## How it was found

The library's fix raised the question of why the VFS's own `close()` does not wait. In the code (upstream `6238f532`):
- `IDBBatchAtomicVFS.close()` calls `IDBContext.close()`, which calls `IDBDatabase.close()` and returns.
- `jClose()` calls `sync(file.synchronous === 'full')`. Under `synchronous=normal`, `sync(false)` waits for `#chain` (the requests made) but not `#txComplete` (the commit), then `reset()` replaces `#txComplete` with a resolved promise, so nothing tracks that transaction any more.
- `jAccess()` runs a readonly `q()` and never syncs.

Then measured with throwaway pages using wa-sqlite alone (`master`'s `src/` and `dist/`, wa-sqlite's own runner through the WebDriver harness of the fork's `probe/stock-browsers`, branch `probe/idb-close`, not pushed).

## Measured

IDB-CLOSE-384 in `mem:measurements/wa-sqlite-prs`. On `master`:
- **A transaction is live when `await vfs.close()` resolves** after a `synchronous=normal` write (20/20 on both engines) and after a `jAccess()` alone (20/20), never after a `full` write, an open or a read.
- **The last commit is lost** when a worker writes with `synchronous=normal`, runs `sqlite3.close()` and `await vfs.close()`, answers, and is terminated: 20/40 on Chrome, 36/40 on Firefox; 0/40 under `full`.
- `indexedDB.deleteDatabase` from the page fires `blocked` right after `close()` only on Chrome (20/20 after a write, 10/20 after `jAccess`), never on Firefox: no usable signal for a test.

With the change: no live transaction at `close()` in any of the five cases on either engine (0/20 each), and no lost commit.

## The change

`IDBContext` keeps, beside `#txComplete`, a set of promises, one per transaction it starts, settled on `complete` or `abort` and removed then; `reset()` does not touch it. `close()` becomes `async`: it waits for `#chain` (errors ignored) so queued calls make their requests, calls `IDBDatabase.close()`, then waits for the set. `IDBBatchAtomicVFS.close()` returns that promise; `VFS.Base.close()` already declares `void|Promise<void>`. Cost: `close()` resolves after the last commit instead of before; `synchronous=normal` still does not wait for a commit in `xSync()`.

## The test

A third case in `test/vfs_commit_survives.js`, `IDBBatchAtomicVFS` only (both builds), with a `write-close` message in its worker: a setup worker creates the table and stays running; 10 times, a worker inserts a row with `synchronous=normal`, closes the database and the VFS, answers, and is terminated; then a new worker counts the rows. On `master` it failed in 10 of 10 runs per engine (5 runs × 2 builds; 1-7 rows of 10 found); with the change 5 of 5 runs green per engine, and upstream's whole suite on Chrome with upstream's own config 15/15 files, 6336 passed, 0 failed. Upstream CI (Chrome) can fail it.

## Posted upstream

PR [#384][pr384], opened 2026-10-21 from `lalexdotcom:idbbatchatomic-close-settle` on `master` at `6238f532`: the test (`be749445`), then the change (`97d0f192`). The body, validated by the user, carries no measurement: the lost commit reproduces in Chrome and Firefox, most reliably in Firefox; the live readonly transaction and WebKit 324094 are named for Safari; `IDBMirrorVFS` "may have a similar problem and is being looked into separately". It does not mention this library.

## What stays ours

- **`IDBMirrorVFS`**, next: no lost commit (`jClose` already waits for its commits since #372), but `jOpen`'s readwrite transaction or a read's is live at `close()` (16-17/20 on Chrome, 20/20 on Firefox).
- **The library's side, once carried:** the pool's `close` path never calls `vfs.close()` today; it would, and the delete worker already does, replacing the two waits before the `closed` and `deleted` replies. The forced-kill quiesce still needs new transactions refused, so `idb-transactions.ts` stays unless the quiesce closes the VFS too (open question, `mem:follow-ups/safari-idb-stranded`).
