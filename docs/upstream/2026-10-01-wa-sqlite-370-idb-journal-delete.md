# wa-sqlite #370 — a journal deletion the lock did not wait for

*2026-10-01 — measured on Chromium and Firefox, in the container*

[pr370]: https://github.com/rhashimoto/wa-sqlite/pull/370
[pr351]: 2026-09-18-wa-sqlite-351-idb-sparse-write.md

**Why this is here.** On `IDBBatchAtomicVFS`, a committed transaction could be rolled back by the next connection to open the database: the first transaction of a new database, or any transaction larger than SQLite's page cache. The VFS released its lock before the deletion of the rollback journal had committed; when the context ended in that window, the deletion was lost, and the next connection found a hot journal. In this library that window is a `close()` or a worker that dies right after a write. Carried in [`patches/`](../../patches) since 2026-10-01.

## How it was found

`mem:follow-ups` had carried it since 2026-09-27 as an intermittent: in full matrices, a second client on `IDBBatchAtomicVFS` counted 0 tables — `vfs-folders` "opens and persists a path exactly at the bound" and `failed-client` "lets a new client open, before close", `expected +0 to be 1`, first on Firefox, then on Chromium. On 2026-10-01 it reproduced in lone cells: whole `chromium · IDBBatchAtomicVFS` cells, `jspi` and `async` alternated, failed 3 times in 21.

Two instruments, in throwaway code on `fix/idb-second-client`:

- **A dump of IndexedDB from the page**, before the second client opens and after it reads 0. Both failures showed the same thing: before, the database intact (`fileSize` 8192, blocks at 0 and 4096) **and a 512-byte `-journal` still stored**; after, `fileSize` 0, no block, no journal. The second client had rolled the database back. In passing runs the journal was gone before the second open, 20 of 20.
- **A trace of every VFS call and IndexedDB transaction**, sent from the worker to the page over a `BroadcastChannel`. The failing run: `jDelete` of the journal opens transaction 16, `jUnlock(NONE)` returns 0.1 ms later, the worker replies and closes, and transaction 16 never completes. In a passing run the same `jUnlock` does not wait either; the transaction had simply committed first.

## The mechanism

SQLite deletes a rollback journal with `syncDir` set on a VFS that reports `SQLITE_IOCAP_BATCH_ATOMIC`. `sqlite3PagerSetFlags` (SQLite 3.53.0, the version wa-sqlite builds) sets `extraSync` for it even at `synchronous=FULL`, and its comment gives the reason: on a file system with atomic writes, a journal that outlives the commit "might resurrect following a power loss and cause the last transaction to roll back".

`IDBBatchAtomicVFS.jDelete` queued the deletion and answered `syncDir` with `sync(false)`, which waits for the calls to be made, not for the transaction to commit — and then `reset()` forgot that transaction. The `sync(true)` in `jUnlock(NONE)`, which the VFS relies on for visibility to other connections, found an empty queue and returned at once.

Batch atomic commits write no journal, so only the transactions that fall back to one are exposed (`sqlite3PagerCommitPhaseOne`, `jrnlBufferSize`, `pagerStress`):

- the first transaction of a new database — batch atomic needs `dbSize > 0`;
- a transaction whose dirty pages spill out of the page cache, which creates the journal on disk;
- a multi-database commit, and a batch write that fails.

## Reproduced

In wa-sqlite's own runner, a worker commits, replies, then keeps its thread busy so nothing more of its context runs; the page terminates it and another worker counts what was committed. On `master`, both builds:

| case | lost |
| --- | --- |
| `CREATE TABLE` in a new database | 5 of 5, both builds |
| 2000 rows of 2000 bytes in one transaction, on an existing database with the default cache | 5 of 5, both builds — 2000 rows back to 0 |
| the first case, terminated on the reply with no busy wait | 12 of 20 |

On both engines with persistent profiles (Playwright, `.work/worst/journal/`, runner `.scratchpad/journal-probe/runner.mjs`), terminated on the reply, 40 runs: **27 of 40 lost on Chromium, 40 of 40 on Firefox.** A writer that closes normally and a reader that opens right after lost nothing in 40, so a live context always lets the deletion commit.

## Two fixes, and the one sent

- **A — `sync()` no longer forgets.** `sync(false)` keeps the pending transaction, so the next `sync(true)` waits for it. It cures the termination case, but the deletion stays in a `default`-durability transaction, so after a power loss the journal could still come back — the case SQLite's comment names.
- **B — `jDelete` honours `syncDir`.** The deletion runs in a `strict` transaction and `jDelete` waits for it with `sync(true)`. Two lines in one method, doing what SQLite asks; in `synchronous=full` `jDelete` is the only caller of `sync(false)`, so A would add nothing on top.

Chosen: B (user, 2026-10-01). A was implemented, verified and carried for a few hours first; its commits stayed on a local branch of the fork clone, deleted on 2026-10-03 after #370 merged.

Cost, medians of 10 interleaved rounds on Chrome, idle machine — the three arms side by side:

| | `master` | A | B |
| --- | ---: | ---: | ---: |
| new database: open, `CREATE TABLE`, close (n=30) | 4.3 ms | 4.7–4.8 ms | 4.7–4.8 ms |
| 200 autocommit `INSERT`s, no journal deleted | 321 ms | 310–319 ms | 317–320 ms |
| 4 MB transaction past the cache | 147 ms | 140–141 ms | 140–142 ms |

## The other VFS, checked

The same defect needs a journal deletion that is not done when `xDelete` returns. Read, then measured with the probe above (5 runs per case, 40 for the tightest ones), on both engines:

| VFS | `syncDir` | deletion | lost |
| --- | --- | --- | --- |
| `OPFSAdaptiveVFS`, asyncify and jspi | 0 | `removeEntry()` not awaited | 0, no journal ever left |
| `OPFSAnyContextVFS`, asyncify and jspi | 0 | `removeEntry()` not awaited | 0, no journal ever left |
| `OPFSWriteAheadVFS`, default and jspi | 1 | awaited | 0 |
| `IDBMirrorVFS` | — | journals live in memory only | not exposed |
| `OPFSCoopSyncVFS`, `AccessHandlePoolVFS` | — | synchronous | not exposed |

An OPFS `removeEntry()` that has been issued completes even when its worker is terminated; an IndexedDB transaction that has not committed is aborted with its context. That difference is the whole of it.

## The test

`test/vfs_commit_survives.js`, in `IDBBatchAtomicVFS.test.js`, with a worker of its own: both cases above, each terminating the writer on its reply while it holds its thread. On `master`: `Expected 0 to be 1.` and `Expected 0 to be 2000.`, on asyncify and jspi. With the change: the file's 138 tests pass, 3 runs of 3; the whole suite 6083 passed, 0 failed.

## Posted upstream

PR [#370][pr370], opened 2026-10-01 from `lalexdotcom:fix/idb-journal-delete`, two commits — the fix (`1ec87548`), then the tests (`57305f73`) — on `master` at `7a4b4241`, which is [#351][pr351]'s merge: the branch was rebased onto it before opening, the two PRs adding their tests at the same line of `IDBBatchAtomicVFS.test.js`. Upstream CI on the head commit is green — [run 36882381550](https://github.com/rhashimoto/wa-sqlite/actions/runs/36882381550), `build (20.x)`, the only check.

It does not mention this library, per the standing rule; the impact is told as a usage example.

## What stays ours

- **The carry.** Hunk B in [`patches/`](../../patches) since 2026-10-01; it leaves at the repin that brings #370.
- **Verified in the library.** The same whole cells, 30 of 30 green with the fix (A, then B), against 3 failures in 21 without; `pnpm test` green on the three configs.
- **No deterministic test here.** `vfs-folders` and `failed-client` catch it only under load, about once in seven cells; the deterministic test is upstream's.

## Merged

**Merged on 2026-10-03** by rhashimoto, as `7fcc30df` on `master`, its `IDBBatchAtomicVFS.js` byte for byte the head the patch carried. It left [`patches/`](../../patches) at the repin of 2026-10-03 to `7fcc30df`.
